#!/usr/bin/env python3
"""
ENKRIT — Local Whisper Subtitle Generator
Uses faster-whisper (runs 100% offline after first model download)
Usage: python3 whisper_sub.py <video_file> <output_srt>
"""

import sys
import os
import json

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: whisper_sub.py <video> <output.srt>"}))
        sys.exit(1)

    video_path = sys.argv[1]
    srt_path   = sys.argv[2]

    # Try faster-whisper first, fallback to openai-whisper
    try:
        from faster_whisper import WhisperModel
        use_faster = True
    except ImportError:
        use_faster = False

    if not use_faster:
        try:
            import whisper
            use_faster = False
        except ImportError:
            print(json.dumps({
                "error": "Whisper not installed. Run: pip3 install faster-whisper"
            }))
            sys.exit(1)

    try:
        print(json.dumps({"status": "loading_model"}), flush=True)

        if use_faster:
            # faster-whisper: tiny model = ~75MB, auto download once
            model = WhisperModel("tiny", device="cpu", compute_type="int8")
            print(json.dumps({"status": "transcribing"}), flush=True)
            segments, info = model.transcribe(
                video_path,
                beam_size=1,
                word_timestamps=False,
                vad_filter=True,
            )
            seg_list = []
            for s in segments:
                text = s.text.strip()
                if text:
                    seg_list.append({"start": s.start, "end": s.end, "text": text})
                if len(seg_list) and len(seg_list) % 5 == 0:
                    print(json.dumps({
                        "status": "progress",
                        "count": len(seg_list),
                        "end": s.end,
                        "duration": getattr(info, "duration", None),
                    }), flush=True)
        else:
            model = whisper.load_model("tiny")
            print(json.dumps({"status": "transcribing"}), flush=True)
            result = model.transcribe(video_path)
            seg_list = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in result["segments"]]

        # Write SRT file
        print(json.dumps({"status": "writing_srt", "count": len(seg_list)}), flush=True)
        with open(srt_path, "w", encoding="utf-8") as f:
            for i, seg in enumerate(seg_list, 1):
                f.write(f"{i}\n")
                f.write(f"{fmt_time(seg['start'])} --> {fmt_time(seg['end'])}\n")
                f.write(f"{seg['text']}\n\n")

        print(json.dumps({"status": "done", "count": len(seg_list), "srt": srt_path}), flush=True)

    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)

def fmt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

if __name__ == "__main__":
    main()
