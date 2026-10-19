//! Small, in-memory WASM ABI. Only the worker supplies pointers to these exports.
//! No file access, subprocesses, network access or game execution.
use lzxd::{Lzxd, WindowSize, MAX_CHUNK_SIZE};

#[no_mangle]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    if length == 0 || length > 65536 {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() && length > 0 {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}

#[no_mangle]
pub extern "C" fn decoder_new(window: u32) -> *mut Lzxd {
    let size = match window {
        0x8000 => WindowSize::KB32,
        0x10000 => WindowSize::KB64,
        0x20000 => WindowSize::KB128,
        0x40000 => WindowSize::KB256,
        0x80000 => WindowSize::KB512,
        0x100000 => WindowSize::MB1,
        0x200000 => WindowSize::MB2,
        _ => return std::ptr::null_mut(),
    };
    Box::into_raw(Box::new(Lzxd::new(size)))
}

#[no_mangle]
pub unsafe extern "C" fn decoder_free(decoder: *mut Lzxd) {
    if !decoder.is_null() {
        drop(Box::from_raw(decoder));
    }
}

#[no_mangle]
pub unsafe extern "C" fn decode_next(
    decoder: *mut Lzxd,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_len: usize,
) -> u32 {
    if decoder.is_null()
        || input.is_null()
        || output.is_null()
        || input_len == 0
        || input_len > 65535
        || output_len == 0
        || output_len > MAX_CHUNK_SIZE
    {
        return 1;
    }
    let chunk = std::slice::from_raw_parts(input, input_len);
    match (*decoder).decompress_next(chunk, output_len) {
        Ok(decoded) if decoded.len() == output_len => {
            std::ptr::copy_nonoverlapping(decoded.as_ptr(), output, output_len);
            0
        }
        _ => 2,
    }
}
