import { describe, expect, it } from "vitest";
import { wav } from "@/lib/audioFile";

describe("wav (업로드용 WAV 생성)", () => {
  it("16bit 모노 PCM 헤더와 샘플 값을 올바르게 쓴다", async () => {
    const blob = wav(new Float32Array([0, 1, -1, 2]), 16_000);
    const v = new DataView(await blob.arrayBuffer());
    const str = (o: number) => String.fromCharCode(...new Uint8Array(v.buffer, o, 4));

    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 4 * 2);
    expect([str(0), str(8), str(12), str(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint16(22, true)).toBe(1); // 모노
    expect(v.getUint32(24, true)).toBe(16_000); // 샘플레이트
    expect(v.getUint16(34, true)).toBe(16); // 16bit
    // 0, 최댓값, 최솟값, 범위를 넘는 값은 잘라냄
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
