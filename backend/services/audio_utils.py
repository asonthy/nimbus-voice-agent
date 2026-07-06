"""
Audio format conversion via a bundled ffmpeg binary (imageio-ffmpeg), so no
system ffmpeg package is required on the host (e.g. Railway).
"""

import subprocess
import tempfile
from pathlib import Path

import imageio_ffmpeg


def webm_to_wav(audio_bytes: bytes) -> bytes:
    """Transcode webm/opus audio (from the browser's MediaRecorder) to 16kHz mono WAV."""
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as src:
        src.write(audio_bytes)
        src_path = Path(src.name)
    dst_path = src_path.with_suffix(".wav")
    try:
        subprocess.run(
            [ffmpeg_exe, "-y", "-i", str(src_path), "-ar", "16000", "-ac", "1", str(dst_path)],
            check=True, capture_output=True,
        )
        return dst_path.read_bytes()
    finally:
        src_path.unlink(missing_ok=True)
        dst_path.unlink(missing_ok=True)
