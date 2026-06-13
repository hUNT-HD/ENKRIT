package com.enkrit.app;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;

/**
 * Minimal GIF89a encoder with a fixed 6x7x6 colour cube palette (252 colours)
 * and standard GIF-LZW compression. Built for short video-clip GIFs:
 * fast (no per-frame quantisation) and dependency-free.
 */
final class Gif89Encoder {

    private Gif89Encoder() {}

    /** Encode frames (already scaled bitmaps, same size) into an animated GIF. */
    static void encode(List<Bitmap> frames, int delayCs, OutputStream out) throws IOException {
        if (frames == null || frames.isEmpty()) throw new IOException("no frames");
        final int w = frames.get(0).getWidth();
        final int h = frames.get(0).getHeight();

        // Header + Logical Screen Descriptor (global colour table, 256 entries)
        out.write(new byte[]{'G', 'I', 'F', '8', '9', 'a'});
        writeShort(out, w);
        writeShort(out, h);
        out.write(0xF7);            // GCT present, 8 bits/pixel, 256 colours
        out.write(0);               // background colour index
        out.write(0);               // aspect ratio
        out.write(buildPalette());  // 768 bytes

        // NETSCAPE looping extension (loop forever)
        out.write(new byte[]{0x21, (byte) 0xFF, 0x0B,
                'N', 'E', 'T', 'S', 'C', 'A', 'P', 'E', '2', '.', '0',
                0x03, 0x01, 0x00, 0x00, 0x00});

        int[] px = new int[w * h];
        byte[] idx = new byte[w * h];
        int[] lzwTable = new int[4096 << 8]; // (prefix<<8)|k → code+1, reused per frame
        for (Bitmap bmp : frames) {
            // Graphic Control Extension (frame delay)
            out.write(new byte[]{0x21, (byte) 0xF9, 0x04, 0x00});
            writeShort(out, delayCs);
            out.write(0); // transparent colour index (unused)
            out.write(0); // block terminator

            // Image Descriptor
            out.write(0x2C);
            writeShort(out, 0);
            writeShort(out, 0);
            writeShort(out, w);
            writeShort(out, h);
            out.write(0); // no local colour table

            bmp.getPixels(px, 0, w, 0, 0, w, h);
            // Ordered (Bayer 4x4) dithering — smooth gradients on the fixed palette
            for (int y = 0; y < h; y++) {
                int row = y * w;
                for (int x = 0; x < w; x++) {
                    int argb = px[row + x];
                    float d = BAYER[(y & 3) * 4 + (x & 3)] / 16f - 0.5f;
                    int r = clamp((int) (((argb >> 16) & 0xFF) + d * 51f));
                    int g = clamp((int) (((argb >> 8) & 0xFF) + d * 42f));
                    int b = clamp((int) ((argb & 0xFF) + d * 51f));
                    int ri = Math.round(r * 5f / 255f);
                    int gi = Math.round(g * 6f / 255f);
                    int bi = Math.round(b * 5f / 255f);
                    idx[row + x] = (byte) (ri * 42 + gi * 6 + bi);
                }
            }
            lzwEncode(idx, out, lzwTable);
        }
        out.write(0x3B); // trailer
        out.flush();
    }

    /* 6 levels red x 7 levels green x 6 levels blue = 252 colours (+4 pad) */
    private static byte[] buildPalette() {
        byte[] p = new byte[256 * 3];
        int n = 0;
        for (int r = 0; r < 6; r++)
            for (int g = 0; g < 7; g++)
                for (int b = 0; b < 6; b++) {
                    p[n++] = (byte) Math.round(r * 255f / 5f);
                    p[n++] = (byte) Math.round(g * 255f / 6f);
                    p[n++] = (byte) Math.round(b * 255f / 5f);
                }
        return p; // remaining 4 entries stay black
    }

    private static final int[] BAYER = {0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5};

    private static int clamp(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

    /* ── GIF-variant LZW (flat int[] table: no boxing, ~10x faster than HashMap) ── */
    private static void lzwEncode(byte[] indices, OutputStream out, int[] table) throws IOException {
        final int MIN_CODE_SIZE = 8;
        out.write(MIN_CODE_SIZE);
        final int CLEAR = 1 << MIN_CODE_SIZE;   // 256
        final int EOI = CLEAR + 1;              // 257

        BitWriter bw = new BitWriter(out);
        java.util.Arrays.fill(table, 0);        // 0 = empty, stored value = code+1
        int codeSize = MIN_CODE_SIZE + 1;
        int nextCode = EOI + 1;

        bw.write(CLEAR, codeSize);
        int prefix = indices[0] & 0xFF;
        for (int i = 1; i < indices.length; i++) {
            int k = indices[i] & 0xFF;
            int key = (prefix << 8) | k;
            int code = table[key];
            if (code != 0) {
                prefix = code - 1;
                continue;
            }
            bw.write(prefix, codeSize);
            if (nextCode < 4096) {
                table[key] = nextCode + 1;
                if (nextCode == (1 << codeSize) && codeSize < 12) codeSize++;
                nextCode++;
            } else {
                bw.write(CLEAR, codeSize);
                java.util.Arrays.fill(table, 0);
                codeSize = MIN_CODE_SIZE + 1;
                nextCode = EOI + 1;
            }
            prefix = k;
        }
        bw.write(prefix, codeSize);
        bw.write(EOI, codeSize);
        bw.finish();
    }

    /** LSB-first bit packer emitting 255-byte GIF sub-blocks. */
    private static final class BitWriter {
        private final OutputStream out;
        private final ByteArrayOutputStream block = new ByteArrayOutputStream(256);
        private int cur = 0, nbits = 0;

        BitWriter(OutputStream out) { this.out = out; }

        void write(int code, int size) throws IOException {
            cur |= code << nbits;
            nbits += size;
            while (nbits >= 8) {
                emit(cur & 0xFF);
                cur >>= 8;
                nbits -= 8;
            }
        }

        private void emit(int b) throws IOException {
            block.write(b);
            if (block.size() == 255) flushBlock();
        }

        private void flushBlock() throws IOException {
            if (block.size() == 0) return;
            out.write(block.size());
            block.writeTo(out);
            block.reset();
        }

        void finish() throws IOException {
            if (nbits > 0) emit(cur & 0xFF);
            flushBlock();
            out.write(0); // block terminator
        }
    }

    private static void writeShort(OutputStream out, int v) throws IOException {
        out.write(v & 0xFF);
        out.write((v >> 8) & 0xFF);
    }
}
