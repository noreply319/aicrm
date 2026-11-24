// 마이크 입력(브라우저 기본 샘플레이트)을 24kHz 모노 PCM16으로 바꿔 약 100ms마다 메인 스레드로 보낸다.
// 실시간 자막(OpenAI Realtime 전사)용. 음량(RMS)도 함께 보내 무음 감지에 쓴다.
const TARGET_RATE = 24000;
const FRAME = 2400; // 100ms

class Pcm24kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // 다음 출력 샘플의 입력 기준 위치 (소수)
    this.prev = 0; // 직전 블록의 마지막 샘플 (보간용)
    this.out = new Int16Array(FRAME);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // 선형 보간으로 다운샘플링. pos는 [-1, ch.length) 범위의 입력 인덱스 (-1은 prev)
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = ch[i + 1];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSq += s * s;
      if (this.n === FRAME) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.sumSq / FRAME) }, [this.out.buffer]);
        this.out = new Int16Array(FRAME);
        this.n = 0;
        this.sumSq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor("pcm24k", Pcm24kProcessor);
