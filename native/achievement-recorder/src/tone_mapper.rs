use std::error::Error;
use std::slice;

use windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCOMPILE_ENABLE_STRICTNESS, D3DCompile};
use windows::Win32::Graphics::Direct3D::{D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BUFFER_DESC, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_VIEWPORT, ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGISurface;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11SurfaceFromDXGISurface;
use windows::core::{Interface, PCSTR};
use windows_capture::frame::Frame;
use windows_capture::settings::ColorFormat;

type ToneMapError = Box<dyn Error + Send + Sync>;

// The screenshot helper estimates a per-image scene peak. A rolling video must
// avoid frame-to-frame pumping, so the same shoulder is evaluated against a
// stable 1000-nit reference (12.5 scRGB, where 1.0 represents 80 nits).
const HDR_SCENE_PEAK_SCRGB: f32 = 12.5;

const TONE_MAP_SHADER: &str = r#"
Texture2D<float4> SourceTexture : register(t0);

cbuffer ToneMapConstants : register(b0)
{
    float ScenePeak;
    float3 Padding;
};

struct VertexOutput
{
    float4 Position : SV_Position;
    float2 TexCoord : TEXCOORD0;
};

VertexOutput vs_main(uint vertexId : SV_VertexID)
{
    VertexOutput output;
    float2 uv = float2((vertexId << 1) & 2, vertexId & 2);
    output.TexCoord = uv;
    output.Position = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    return output;
}

float tone_map_linear(float value)
{
    value = max(value, 0.0);
    if (ScenePeak <= 1.05)
    {
        return saturate(value);
    }

    const float knee = 0.80;
    if (value <= knee)
    {
        return value;
    }

    float peak = max(ScenePeak, knee + 0.001);
    float numerator = log(1.0 + 20.0 * (min(value, peak) - knee));
    float denominator = log(1.0 + 20.0 * (peak - knee));
    return saturate(knee + (1.0 - knee) * numerator / denominator);
}

float linear_to_srgb(float value)
{
    value = saturate(value);
    return value <= 0.0031308
        ? value * 12.92
        : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

float4 ps_main(VertexOutput input) : SV_Target
{
    uint width;
    uint height;
    SourceTexture.GetDimensions(width, height);
    int2 pixel = int2(
        min((uint)(input.TexCoord.x * width), width - 1),
        min((uint)(input.TexCoord.y * height), height - 1)
    );
    float3 linearColor = SourceTexture.Load(int3(pixel, 0)).rgb;
    float3 mapped = float3(
        linear_to_srgb(tone_map_linear(linearColor.r)),
        linear_to_srgb(tone_map_linear(linearColor.g)),
        linear_to_srgb(tone_map_linear(linearColor.b))
    );
    return float4(mapped, 1.0);
}
"#;

#[repr(C)]
struct ToneMapConstants {
    scene_peak: f32,
    padding: [f32; 3],
}

fn compile_shader(entry: &'static [u8], target: &'static [u8]) -> Result<Vec<u8>, ToneMapError> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let compile_result = unsafe {
        D3DCompile(
            TONE_MAP_SHADER.as_ptr().cast(),
            TONE_MAP_SHADER.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry.as_ptr()),
            PCSTR(target.as_ptr()),
            D3DCOMPILE_ENABLE_STRICTNESS,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if let Err(error) = compile_result {
        let details = errors
            .as_ref()
            .map(|blob| unsafe {
                let bytes = slice::from_raw_parts(
                    blob.GetBufferPointer().cast::<u8>(),
                    blob.GetBufferSize(),
                );
                String::from_utf8_lossy(bytes).trim().to_string()
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| error.to_string());
        return Err(format!("HDR tone-map shader compilation failed: {details}").into());
    }
    let code = code.ok_or("HDR tone-map shader compiler returned no bytecode")?;
    let bytes = unsafe {
        slice::from_raw_parts(code.GetBufferPointer().cast::<u8>(), code.GetBufferSize())
    };
    Ok(bytes.to_vec())
}

pub struct ToneMapper {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    source_width: u32,
    source_height: u32,
    output_width: u32,
    output_height: u32,
    input_texture: ID3D11Texture2D,
    input_view: ID3D11ShaderResourceView,
    vertex_shader: ID3D11VertexShader,
    pixel_shader: ID3D11PixelShader,
    constants: ID3D11Buffer,
}

impl ToneMapper {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        source_width: u32,
        source_height: u32,
        output_width: u32,
        output_height: u32,
    ) -> Result<Self, ToneMapError> {
        let vertex_bytecode = compile_shader(b"vs_main\0", b"vs_5_0\0")?;
        let pixel_bytecode = compile_shader(b"ps_main\0", b"ps_5_0\0")?;

        let mut vertex_shader = None;
        let mut pixel_shader = None;
        unsafe {
            device.CreateVertexShader(&vertex_bytecode, None, Some(&mut vertex_shader))?;
            device.CreatePixelShader(&pixel_bytecode, None, Some(&mut pixel_shader))?;
        }
        let vertex_shader = vertex_shader.ok_or("D3D11 returned no HDR vertex shader")?;
        let pixel_shader = pixel_shader.ok_or("D3D11 returned no HDR pixel shader")?;

        let input_desc = D3D11_TEXTURE2D_DESC {
            Width: source_width,
            Height: source_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut input_texture = None;
        unsafe { device.CreateTexture2D(&input_desc, None, Some(&mut input_texture))? };
        let input_texture = input_texture.ok_or("D3D11 returned no HDR input texture")?;
        let mut input_view = None;
        unsafe { device.CreateShaderResourceView(&input_texture, None, Some(&mut input_view))? };
        let input_view = input_view.ok_or("D3D11 returned no HDR shader-resource view")?;

        let constants = ToneMapConstants {
            scene_peak: HDR_SCENE_PEAK_SCRGB,
            padding: [0.0; 3],
        };
        let constant_desc = D3D11_BUFFER_DESC {
            ByteWidth: std::mem::size_of::<ToneMapConstants>() as u32,
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
            StructureByteStride: 0,
        };
        let initial = D3D11_SUBRESOURCE_DATA {
            pSysMem: (&constants as *const ToneMapConstants).cast(),
            SysMemPitch: 0,
            SysMemSlicePitch: 0,
        };
        let mut constant_buffer = None;
        unsafe { device.CreateBuffer(&constant_desc, Some(&initial), Some(&mut constant_buffer))? };
        let constant_buffer = constant_buffer.ok_or("D3D11 returned no HDR constant buffer")?;

        Ok(Self {
            device,
            context,
            source_width,
            source_height,
            output_width,
            output_height,
            input_texture,
            input_view,
            vertex_shader,
            pixel_shader,
            constants: constant_buffer,
        })
    }

    pub fn convert(&self, frame: &Frame) -> Result<IDirect3DSurface, ToneMapError> {
        if frame.color_format() != ColorFormat::Rgba16F {
            return Err("HDR tone mapper received a non-FP16 capture frame".into());
        }
        if frame.width() != self.source_width || frame.height() != self.source_height {
            return Err("HDR capture dimensions changed while recording".into());
        }

        let output_desc = D3D11_TEXTURE2D_DESC {
            Width: self.output_width,
            Height: self.output_height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut output_texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&output_desc, None, Some(&mut output_texture))?
        };
        let output_texture = output_texture.ok_or("D3D11 returned no SDR output texture")?;
        let mut render_target = None;
        unsafe {
            self.device
                .CreateRenderTargetView(&output_texture, None, Some(&mut render_target))?
        };
        let render_target = render_target.ok_or("D3D11 returned no SDR render-target view")?;

        unsafe {
            self.context
                .CopyResource(&self.input_texture, frame.as_raw_texture());
            self.context.IASetInputLayout(None);
            self.context
                .IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex_shader, None);
            self.context.PSSetShader(&self.pixel_shader, None);
            self.context
                .PSSetShaderResources(0, Some(&[Some(self.input_view.clone())]));
            self.context
                .PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
            self.context
                .OMSetRenderTargets(Some(&[Some(render_target)]), None);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.output_width as f32,
                Height: self.output_height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            }]));
            self.context.Draw(3, 0);
            self.context.ClearState();
            self.context.Flush();
        }

        let dxgi_surface: IDXGISurface = output_texture.cast()?;
        let inspectable = unsafe { CreateDirect3D11SurfaceFromDXGISurface(&dxgi_surface)? };
        Ok(inspectable.cast()?)
    }
}
