//! A single continuous Media Foundation encoder. Encoded samples can be replayed
//! into an MP4 sink without decoding them or opening another video encoder.
use super::{AnyError, FrameRate, recorder_bitrate};
use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::path::Path;
use std::sync::{Arc, Mutex};
use windows::Win32::Foundation::{E_NOTIMPL, RECT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::core::{Interface, Ref, Result, implement};
use windows_capture::d3d11::SendDirectX;

pub fn attributes() -> Result<IMFAttributes> {
    let mut value = None;
    unsafe {
        MFCreateAttributes(&mut value, 8)?;
    }
    Ok(value.unwrap())
}

pub fn packed(a: u32, b: u32) -> u64 {
    (u64::from(a) << 32) | u64::from(b)
}

pub fn video_type(
    width: u32,
    height: u32,
    rate: FrameRate,
    compressed: bool,
) -> Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(
            &MF_MT_SUBTYPE,
            if compressed {
                &MFVideoFormat_H264
            } else {
                &MFVideoFormat_NV12
            },
        )?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, packed(width, height))?;
        t.SetUINT64(&MF_MT_FRAME_RATE, packed(rate.numerator, rate.denominator))?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, packed(1, 1))?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        if compressed {
            t.SetUINT32(
                &MF_MT_AVG_BITRATE,
                recorder_bitrate(width, height, rate.ceil_fps()),
            )?;
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, 100)?;
        }
        Ok(t)
    }
}

pub fn pcm_type() -> Result<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
        t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
        t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 192_000)?;
        t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        Ok(t)
    }
}

fn candidates(video: bool, hardware: bool) -> Result<Vec<IMFActivate>> {
    let out = MFT_REGISTER_TYPE_INFO {
        guidMajorType: if video {
            MFMediaType_Video
        } else {
            MFMediaType_Audio
        },
        guidSubtype: if video {
            MFVideoFormat_H264
        } else {
            MFAudioFormat_AAC
        },
    };
    let mut array = std::ptr::null_mut();
    let mut count = 0;
    unsafe {
        MFTEnumEx(
            if video {
                MFT_CATEGORY_VIDEO_ENCODER
            } else {
                MFT_CATEGORY_AUDIO_ENCODER
            },
            (if hardware {
                MFT_ENUM_FLAG_HARDWARE
            } else {
                MFT_ENUM_FLAG_SYNCMFT
            }) | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&out),
            &mut array,
            &mut count,
        )?;
        let entries = if count == 0 {
            &mut []
        } else {
            std::slice::from_raw_parts_mut(array, count as usize)
        };
        let result = entries.iter_mut().filter_map(Option::take).collect();
        CoTaskMemFree(Some(array.cast()));
        Ok(result)
    }
}

fn transform_name(a: &IMFActivate) -> String {
    unsafe {
        let mut text = windows::core::PWSTR::null();
        let mut len = 0;
        if a.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut text, &mut len)
            .is_err()
        {
            return "Media Foundation encoder".into();
        }
        let name = text.to_string().unwrap_or_default();
        CoTaskMemFree(Some(text.0.cast()));
        name
    }
}

/// A compressed sample is immutable once inserted in the replay buffer. Save
/// workers make a new sample header, retaining only its compressed media buffer.
#[derive(Clone)]
pub struct Packet {
    pub sample: IMFSample,
    pub time: i64,
    pub duration: i64,
    pub decode_time: i64,
    pub keyframe: bool,
    pub video: bool,
    pub size: usize,
    pub memory: Option<Arc<super::replay::MemoryCharge>>,
}
// IMF samples/buffers used here are free-threaded. No sample attributes are
// changed after publication; every muxer has a separate sample header.
unsafe impl Send for Packet {}
unsafe impl Sync for Packet {}

pub struct Transform {
    inner: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    input_id: u32,
    output_id: u32,
    credit: usize,
    pub output_type: IMFMediaType,
    pub name: String,
    pub hardware: bool,
    video: bool,
    pub submitted: u64,
    pub produced: u64,
    pending: VecDeque<i64>,
}

impl Transform {
    pub fn video(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        rate: FrameRate,
        allow_software: bool,
    ) -> std::result::Result<Self, AnyError> {
        let mut failures = Vec::new();
        let mut only_profile_failures = true;
        for hardware in [true, false] {
            if !hardware && !allow_software {
                continue;
            }
            for activation in candidates(true, hardware)? {
                let name = transform_name(&activation);
                let configured = (|| -> Result<Self> {
                    unsafe {
                        let inner: IMFTransform = activation.ActivateObject()?;
                        let attrs = inner.GetAttributes()?;
                        let asynchronous = attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0;
                        if asynchronous {
                            attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                        }
                        if hardware {
                            if attrs.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) == 0 {
                                return Err(windows::core::Error::from_hresult(E_NOTIMPL));
                            }
                            let mut token = 0;
                            let mut manager = None;
                            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                            let manager = manager.unwrap();
                            manager.ResetDevice(device, token)?;
                            inner.ProcessMessage(
                                MFT_MESSAGE_SET_D3D_MANAGER,
                                manager.as_raw() as usize,
                            )?;
                        }
                        let (input_id, output_id) = stream_ids(&inner);
                        let output = video_type(width, height, rate, true)?;
                        let mut selected =
                            Err(windows::core::Error::from_hresult(MF_E_INVALIDMEDIATYPE));
                        for profile in [100, 77, 66] {
                            output.SetUINT32(&MF_MT_MPEG2_PROFILE, profile)?;
                            selected = inner.SetOutputType(output_id, &output, 0);
                            if selected.is_ok() {
                                break;
                            }
                        }
                        selected?;
                        inner.SetInputType(
                            input_id,
                            &video_type(width, height, rate, false)?,
                            0,
                        )?;
                        // No B frames keeps replay cuts simple. Unsupported optional
                        // tuning is harmless; actual DTS is still preserved below.
                        if let Ok(codec) = inner.cast::<ICodecAPI>() {
                            use windows::Win32::System::Variant::VARIANT;
                            let _ = codec.SetValue(
                                &CODECAPI_AVEncMPVDefaultBPictureCount,
                                &VARIANT::from(0u32),
                            );
                            let _ = codec.SetValue(
                                &CODECAPI_AVEncMPVGOPSize,
                                &VARIANT::from(rate.ceil_fps().max(1)),
                            );
                        }
                        inner.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                        inner.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                        Ok(Self {
                            output_type: inner.GetOutputCurrentType(output_id)?,
                            events: if asynchronous {
                                Some(inner.cast()?)
                            } else {
                                None
                            },
                            inner,
                            input_id,
                            output_id,
                            credit: 0,
                            name: name.clone(),
                            hardware,
                            video: true,
                            submitted: 0,
                            produced: 0,
                            pending: VecDeque::new(),
                        })
                    }
                })();
                match configured {
                    Ok(t) => return Ok(t),
                    Err(e) => {
                        only_profile_failures &= [
                            E_NOTIMPL,
                            windows::Win32::Foundation::E_INVALIDARG,
                            MF_E_INVALIDMEDIATYPE,
                            MF_E_INVALID_PROFILE,
                            MF_E_TOPO_CODEC_NOT_FOUND,
                            MF_E_NO_MORE_TYPES,
                        ]
                        .contains(&e.code());
                        let _ = unsafe { activation.ShutdownObject() };
                        failures.push(format!("{name}: {e}"));
                    }
                }
            }
        }
        let message = format!(
            "No compatible H.264 encoder for {}x{} at {}/{} FPS: {}",
            width,
            height,
            rate.numerator,
            rate.denominator,
            failures.join("; ")
        );
        Err(if only_profile_failures {
            Box::new(super::UnsupportedRecorderProfile(message)) as AnyError
        } else {
            message.into()
        })
    }

    pub fn audio() -> std::result::Result<Self, AnyError> {
        for a in candidates(false, false)? {
            unsafe {
                let inner: IMFTransform = a.ActivateObject()?;
                let (input_id, output_id) = stream_ids(&inner);
                let mut selected = false;
                for i in 0..128 {
                    let Ok(out) = inner.GetOutputAvailableType(output_id, i) else {
                        break;
                    };
                    if out.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(0) == 48_000
                        && out.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0) == 2
                        && out
                            .GetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND)
                            .unwrap_or(0)
                            == 24_000
                        && inner.SetOutputType(output_id, &out, 0).is_ok()
                    {
                        selected = true;
                        break;
                    }
                }
                if !selected || inner.SetInputType(input_id, &pcm_type()?, 0).is_err() {
                    continue;
                }
                inner.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                inner.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                return Ok(Self {
                    output_type: inner.GetOutputCurrentType(output_id)?,
                    inner,
                    events: None,
                    input_id,
                    output_id,
                    credit: 0,
                    name: transform_name(&a),
                    hardware: false,
                    video: false,
                    submitted: 0,
                    produced: 0,
                    pending: VecDeque::new(),
                });
            }
        }
        Err("No compatible AAC encoder".into())
    }

    pub fn poll(&mut self) -> Result<Vec<Packet>> {
        let mut packets = Vec::new();
        if let Some(events) = self.events.clone() {
            loop {
                let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                    Ok(e) => e,
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                    Err(e) => return Err(e),
                };
                unsafe {
                    event.GetStatus()?.ok()?;
                }
                match unsafe { event.GetType()? } {
                    n if n == METransformNeedInput.0 as u32 => self.credit += 1,
                    n if n == METransformHaveOutput.0 as u32 => {
                        if let Some(p) = self.output()? {
                            packets.push(p);
                        }
                    }
                    _ => (),
                }
            }
        } else {
            while let Some(p) = self.output()? {
                packets.push(p);
            }
        }
        Ok(packets)
    }

    pub fn ready(&self) -> bool {
        self.events.is_none() || self.credit > 0
    }
    pub fn oldest_pending(&self) -> Option<i64> {
        self.pending.front().copied()
    }

    pub fn submit(&mut self, sample: &IMFSample) -> Result<bool> {
        if !self.ready() {
            return Ok(false);
        }
        match unsafe { self.inner.ProcessInput(self.input_id, sample, 0) } {
            Ok(()) => {
                if self.events.is_some() {
                    self.credit = self.credit.saturating_sub(1);
                }
                self.submitted += 1;
                self.pending.push_back(unsafe { sample.GetSampleTime()? });
                Ok(true)
            }
            Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn force_keyframe(&self) -> Result<()> {
        let codec = self.inner.cast::<ICodecAPI>()?;
        unsafe {
            codec.SetValue(
                &CODECAPI_AVEncVideoForceKeyFrame,
                &windows::Win32::System::Variant::VARIANT::from(1u32),
            )
        }
    }

    pub fn drain(&self) -> Result<()> {
        unsafe {
            self.inner
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.inner.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)
        }
    }

    fn output(&mut self) -> Result<Option<Packet>> {
        self.output_with_format_change(true)
    }

    fn output_with_format_change(&mut self, allow_change: bool) -> Result<Option<Packet>> {
        unsafe {
            let info = self.inner.GetOutputStreamInfo(self.output_id)?;
            let sample = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0 {
                None
            } else {
                let s = MFCreateSample()?;
                s.AddBuffer(&MFCreateAlignedMemoryBuffer(
                    info.cbSize.max(1),
                    info.cbAlignment.saturating_sub(1),
                )?)?;
                Some(s)
            };
            let mut out = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: self.output_id,
                pSample: ManuallyDrop::new(sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let result = self.inner.ProcessOutput(0, &mut out, &mut 0);
            let sample = ManuallyDrop::take(&mut out[0].pSample);
            drop(ManuallyDrop::take(&mut out[0].pEvents));
            match result {
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    if !allow_change {
                        return Err(e);
                    }
                    let t = self.inner.GetOutputAvailableType(self.output_id, 0)?;
                    self.inner.SetOutputType(self.output_id, &t, 0)?;
                    self.output_type = self.inner.GetOutputCurrentType(self.output_id)?;
                    return self.output_with_format_change(false);
                }
                other => other?,
            }
            let Some(sample) = sample else {
                return Ok(None);
            };
            let length = sample.GetTotalLength()?;
            if length == 0 {
                return Ok(None);
            }
            let time = sample.GetSampleTime()?;
            let duration = sample.GetSampleDuration().unwrap_or(0);
            let decode_time = sample
                .GetUINT64(&MFSampleExtension_DecodeTimestamp)
                .map(|n| n as i64)
                .unwrap_or(time);
            if self.video {
                if let Some(i) = self.pending.iter().position(|t| *t == time) {
                    self.pending.remove(i);
                }
            } else {
                while self
                    .pending
                    .front()
                    .is_some_and(|t| *t < time.saturating_add(duration))
                {
                    self.pending.pop_front();
                }
            }
            // Encoder-owned buffers may be oversized or come from a finite
            // driver pool. Retain only a tightly sized copy of compressed data,
            // not the encoder's allocation, throughout the replay/save window.
            let retained_buffer = MFCreateMemoryBuffer(length)?;
            sample.CopyToBuffer(&retained_buffer)?;
            let retained_sample = MFCreateSample()?;
            sample.CopyAllItems(&retained_sample)?;
            retained_sample.AddBuffer(&retained_buffer)?;
            retained_sample.SetSampleTime(time)?;
            retained_sample.SetSampleDuration(duration)?;
            self.produced += 1;
            Ok(Some(Packet {
                memory: None,
                size: retained_buffer.GetMaxLength()? as usize,
                keyframe: !self.video
                    || sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0,
                sample: retained_sample,
                time,
                duration,
                decode_time,
                video: self.video,
            }))
        }
    }
}

impl Drop for Transform {
    fn drop(&mut self) {
        unsafe {
            let _ = self.inner.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .inner
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
    }
}

fn stream_ids(t: &IMFTransform) -> (u32, u32) {
    let (mut input, mut output) = ([0], [0]);
    let _ = unsafe { t.GetStreamIDs(&mut input, &mut output) };
    (input[0], output[0])
}

pub fn bytes_sample(bytes: &[u8], time: i64, duration: i64) -> Result<IMFSample> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None)?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(bytes.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(time)?;
        sample.SetSampleDuration(duration)?;
        Ok(sample)
    }
}

type TexturePool = Arc<Mutex<Vec<SendDirectX<ID3D11Texture2D>>>>;
#[implement(IMFAsyncCallback)]
struct RecycleTexture {
    pool: TexturePool,
    texture: Mutex<Option<SendDirectX<ID3D11Texture2D>>>,
}
impl IMFAsyncCallback_Impl for RecycleTexture_Impl {
    fn GetParameters(&self, _: *mut u32, _: *mut u32) -> Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }
    fn Invoke(&self, _: Ref<IMFAsyncResult>) -> Result<()> {
        if let Some(texture) = self.texture.lock().unwrap().take() {
            self.pool.lock().unwrap().push(texture);
        }
        Ok(())
    }
}

pub struct GpuConverter {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    width: u32,
    height: u32,
    pool: TexturePool,
    allocated: usize,
    max_textures: usize,
}

impl GpuConverter {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        width: u32,
        height: u32,
        rate: FrameRate,
    ) -> Result<Self> {
        unsafe {
            let _ = context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);
            let video_device: ID3D11VideoDevice = device.cast()?;
            let video_context: ID3D11VideoContext = context.cast()?;
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL {
                    Numerator: rate.numerator,
                    Denominator: rate.denominator,
                },
                InputWidth: width,
                InputHeight: height,
                OutputFrameRate: DXGI_RATIONAL {
                    Numerator: rate.numerator,
                    Denominator: rate.denominator,
                },
                OutputWidth: width,
                OutputHeight: height,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&desc)?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;
            // RGB full range -> BT.709 studio-range NV12; disable optional filters.
            video_context.VideoProcessorSetStreamColorSpace(
                &processor,
                0,
                &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 },
            );
            video_context.VideoProcessorSetOutputColorSpace(
                &processor,
                &D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: (1 << 2) | (1 << 4),
                },
            );
            if let Ok(v1) = video_context.cast::<ID3D11VideoContext1>() {
                v1.VideoProcessorSetStreamColorSpace1(
                    &processor,
                    0,
                    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                );
                v1.VideoProcessorSetOutputColorSpace1(
                    &processor,
                    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
                );
            }
            video_context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            let rect = RECT {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };
            video_context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&rect));
            video_context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&rect));
            let bytes = u64::from(width) * u64::from(height) * 3 / 2;
            Ok(Self {
                device,
                context,
                video_device,
                video_context,
                enumerator,
                processor,
                width,
                height,
                pool: Arc::new(Mutex::new(Vec::new())),
                allocated: 0,
                max_textures: (128 * 1024 * 1024 / bytes.max(1)).clamp(2, 16) as usize,
            })
        }
    }

    pub fn sample(
        &mut self,
        input: &ID3D11Texture2D,
        time: i64,
        duration: i64,
        hardware: bool,
    ) -> Result<Option<IMFSample>> {
        unsafe {
            let available = self.pool.lock().unwrap().pop();
            let texture = match available {
                Some(t) => t.0,
                None if self.allocated < self.max_textures => {
                    let mut texture = None;
                    self.device.CreateTexture2D(
                        &D3D11_TEXTURE2D_DESC {
                            Width: self.width,
                            Height: self.height,
                            MipLevels: 1,
                            ArraySize: 1,
                            Format: DXGI_FORMAT_NV12,
                            SampleDesc: DXGI_SAMPLE_DESC {
                                Count: 1,
                                Quality: 0,
                            },
                            Usage: D3D11_USAGE_DEFAULT,
                            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                            ..Default::default()
                        },
                        None,
                        Some(&mut texture),
                    )?;
                    self.allocated += 1;
                    texture.unwrap()
                }
                None => return Ok(None),
            };
            let recycle: IMFAsyncCallback = RecycleTexture {
                pool: self.pool.clone(),
                texture: Mutex::new(Some(SendDirectX(texture.clone()))),
            }
            .into();
            let tracked = MFCreateTrackedSample()?;
            tracked.SetAllocator(&recycle, None)?;
            let sample: IMFSample = tracked.cast()?;
            let mut input_view = None;
            let mut input_desc = D3D11_TEXTURE2D_DESC::default();
            input.GetDesc(&mut input_desc);
            let source = RECT {
                left: 0,
                top: 0,
                right: input_desc.Width as i32,
                bottom: input_desc.Height as i32,
            };
            self.video_context.VideoProcessorSetStreamSourceRect(
                &self.processor,
                0,
                true,
                Some(&source),
            );
            let scale = (self.width as f64 / input_desc.Width as f64)
                .min(self.height as f64 / input_desc.Height as f64);
            let w = (input_desc.Width as f64 * scale) as i32;
            let h = (input_desc.Height as f64 * scale) as i32;
            let left = (self.width as i32 - w) / 2;
            let top = (self.height as i32 - h) / 2;
            let target = RECT {
                left,
                top,
                right: left + w,
                bottom: top + h,
            };
            self.video_context.VideoProcessorSetStreamDestRect(
                &self.processor,
                0,
                true,
                Some(&target),
            );
            self.video_device.CreateVideoProcessorInputView(
                input,
                &self.enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input_view),
            )?;
            let mut output_view = None;
            self.video_device.CreateVideoProcessorOutputView(
                &texture,
                &self.enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output_view),
            )?;
            let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input_view),
                ..Default::default()
            }];
            let converted = self.video_context.VideoProcessorBlt(
                &self.processor,
                output_view.as_ref().unwrap(),
                0,
                &streams,
            );
            drop(ManuallyDrop::take(&mut streams[0].pInputSurface));
            converted?;
            self.context.Flush();
            if hardware {
                sample.AddBuffer(&MFCreateDXGISurfaceBuffer(
                    &ID3D11Texture2D::IID,
                    &texture,
                    0,
                    false,
                )?)?;
            } else {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                let mut staging = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut staging))?;
                let staging = staging.unwrap();
                self.context.CopyResource(&staging, &texture);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context
                    .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                let mut bytes = vec![0u8; (self.width * self.height * 3 / 2) as usize];
                for row in 0..(self.height * 3 / 2) as usize {
                    std::ptr::copy_nonoverlapping(
                        mapped
                            .pData
                            .cast::<u8>()
                            .add(row * mapped.RowPitch as usize),
                        bytes.as_mut_ptr().add(row * self.width as usize),
                        self.width as usize,
                    );
                }
                self.context.Unmap(&staging, 0);
                sample.AddBuffer(&bytes_sample(&bytes, time, duration)?.GetBufferByIndex(0)?)?;
            }
            sample.SetSampleTime(time)?;
            sample.SetSampleDuration(duration)?;
            Ok(Some(sample))
        }
    }
}

/// Mux only. Input/output types are identical compressed types, so the writer
/// does not instantiate an encoder. Every clip starts at a retained keyframe.
pub fn save_mp4(
    path: &Path,
    video: &IMFMediaType,
    audio: Option<&IMFMediaType>,
    packets: &[Packet],
    origin: i64,
) -> std::result::Result<(), AnyError> {
    unsafe {
        let attrs = attributes()?;
        attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1)?;
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        let url = windows::core::HSTRING::from(path.as_os_str());
        let writer = MFCreateSinkWriterFromURL(&url, None, &attrs)?;
        let vi = writer.AddStream(video)?;
        writer.SetInputMediaType(vi, video, None)?;
        let ai = if let Some(t) = audio {
            let i = writer.AddStream(t)?;
            writer.SetInputMediaType(i, t, None)?;
            Some(i)
        } else {
            None
        };
        writer.BeginWriting()?;
        if let Ok(extended) = writer.cast::<IMFSinkWriterEx>() {
            for stream in std::iter::once(vi).chain(ai) {
                for index in 0..8 {
                    let mut category = windows::core::GUID::zeroed();
                    let mut transform = None;
                    if extended
                        .GetTransformForStream(stream, index, Some(&mut category), &mut transform)
                        .is_err()
                    {
                        break;
                    }
                    if category == MFT_CATEGORY_VIDEO_ENCODER
                        || category == MFT_CATEGORY_AUDIO_ENCODER
                    {
                        return Err("MP4 replay unexpectedly requested reencoding".into());
                    }
                }
            }
        }
        let base = packets
            .iter()
            .filter(|p| p.video)
            .map(|p| p.decode_time)
            .min()
            .unwrap_or(origin)
            .min(origin);
        for p in packets {
            if p.time < origin {
                continue;
            }
            let sample = MFCreateSample()?;
            p.sample.CopyAllItems(&sample)?;
            for i in 0..p.sample.GetBufferCount()? {
                sample.AddBuffer(&p.sample.GetBufferByIndex(i)?)?;
            }
            sample.SetSampleTime(p.time - base)?;
            sample.SetSampleDuration(p.duration.max(1))?;
            // Negative DTS is legitimate with B frames. Avoid unsigned wrap; muxer
            // can derive DTS when the original stream does not expose one.
            if p.decode_time >= base {
                sample.SetUINT64(
                    &MFSampleExtension_DecodeTimestamp,
                    (p.decode_time - base) as u64,
                )?;
            } else {
                let _ = sample.DeleteItem(&MFSampleExtension_DecodeTimestamp);
            }
            let stream = if p.video {
                vi
            } else if let Some(i) = ai {
                i
            } else {
                continue;
            };
            writer.WriteSample(stream, &sample)?;
        }
        writer.Finalize()?;
        Ok(())
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::time::{Duration, Instant};
    // Requires a Windows GPU/driver. Explicitly invoked, never run by normal
    // unit tests or by Customisation. Artifacts stay in the system temp folder.
    #[test]
    #[ignore]
    fn hardware_encode_and_mux_without_reencoding() -> std::result::Result<(), AnyError> {
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )?;
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }
        let (device, context) = windows_capture::d3d11::create_d3d_device()?;
        let dir = std::env::var_os("ACHIEVEMENTS_RECORD_TEST_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("Achievements-recorder-media-tests"));
        std::fs::create_dir_all(&dir)?;
        for fps in [30, 60, 240] {
            let rate = FrameRate::fixed(fps);
            let width = 1280;
            let height = 720;
            let mut encoder = Transform::video(&device, width, height, rate, true)?;
            println!(
                "fps={fps} encoder={} hardware={}",
                encoder.name, encoder.hardware
            );
            let mut converter =
                GpuConverter::new(device.clone(), context.clone(), width, height, rate)?;
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                ..Default::default()
            };
            let mut texture = None;
            unsafe {
                device.CreateTexture2D(&desc, None, Some(&mut texture))?;
            }
            let texture = texture.unwrap();
            // A changed/odd capture size must not invalidate the fixed output
            // format or corrupt a running recording.
            let resized_desc = D3D11_TEXTURE2D_DESC {
                Width: 641,
                Height: 361,
                ..desc
            };
            let mut resized = None;
            unsafe {
                device.CreateTexture2D(&resized_desc, None, Some(&mut resized))?;
            }
            let resized = resized.unwrap();
            let mut rtv = None;
            unsafe {
                device.CreateRenderTargetView(&texture, None, Some(&mut rtv))?;
            }
            let rtv = rtv.unwrap();
            let mut packets = Vec::new();
            let origin = super::super::qpc_ticks();
            let started = Instant::now();
            let mut forced_keyframe = false;
            for i in 0..fps * 2 {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    packets.extend(encoder.poll()?);
                    if encoder.ready() {
                        break;
                    }
                    assert!(Instant::now() < deadline, "encoder did not request input");
                    std::thread::sleep(Duration::from_millis(1));
                }
                unsafe {
                    context
                        .ClearRenderTargetView(&rtv, &[i as f32 / (fps * 2) as f32, 0.2, 0.7, 1.0]);
                }
                let time = origin + i64::from(i) * 10_000_000 / i64::from(fps);
                let duration = origin + i64::from(i + 1) * 10_000_000 / i64::from(fps) - time;
                if i == fps / 2 {
                    forced_keyframe = encoder.force_keyframe().is_ok();
                }
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    if let Some(sample) = converter.sample(
                        if i == fps { &resized } else { &texture },
                        time,
                        duration,
                        encoder.hardware,
                    )? {
                        assert!(encoder.submit(&sample)?);
                        break;
                    }
                    packets.extend(encoder.poll()?);
                    assert!(
                        Instant::now() < deadline,
                        "GPU surfaces did not return to pool"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
                packets.extend(encoder.poll()?);
            }
            encoder.drain()?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while encoder.produced < encoder.submitted && Instant::now() < deadline {
                packets.extend(encoder.poll()?);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                encoder.produced, encoder.submitted,
                "missing output samples at {fps} FPS"
            );
            assert!(
                packets[0].keyframe,
                "first sample was not independently decodable"
            );
            if forced_keyframe {
                assert!(
                    packets
                        .iter()
                        .any(|p| p.time == origin + 5_000_000 && p.keyframe),
                    "encoder accepted the forced keyframe but did not produce it"
                );
            }
            encoder.output_type = unsafe { encoder.inner.GetOutputCurrentType(encoder.output_id)? };
            let path = dir.join(format!("hardware-{fps}fps.mp4"));
            std::fs::File::create(&path)?;
            save_mp4(&path, &encoder.output_type, None, &packets, origin)?;
            let packet_count = packets.len();
            let total_bytes: usize = packets.iter().map(|p| p.size).sum();
            let mut ring = super::super::replay::Buffer::new(64 * 1024 * 1024);
            for packet in packets {
                ring.push(packet)?;
            }
            assert_eq!(ring.retained_bytes(), total_bytes);
            let (cut_origin, cut) = ring
                .select(origin + 5_000_000, origin + 15_000_000)
                .expect("keyframe for cut");
            assert!(cut.iter().find(|p| p.video).unwrap().keyframe);
            ring.prune(i64::MAX);
            assert!(ring.bytes < total_bytes);
            assert!(
                ring.retained_bytes() > ring.bytes,
                "save must retain its evicted packets"
            );
            save_mp4(
                &dir.join(format!("hardware-{fps}fps-cut.mp4")),
                &encoder.output_type,
                None,
                &cut,
                cut_origin,
            )?;
            drop(cut);
            assert_eq!(ring.retained_bytes(), ring.bytes);
            println!(
                "{} packets={} forcedKeyframe={} elapsedMs={}",
                path.display(),
                packet_count,
                forced_keyframe,
                started.elapsed().as_millis()
            );
        }
        Ok(())
    }
}
