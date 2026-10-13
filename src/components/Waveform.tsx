import { useEffect, useRef } from "react";

interface WaveformProps {
  peaks: number[];
  progress: number;
}

export function Waveform({ peaks, progress }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const gap = 2;
    const count = Math.max(peaks.length, 1);
    const barWidth = Math.max(1, (width - gap * (count - 1)) / count);
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(2, peak * (height - 8));
      const x = index * (barWidth + gap);
      const y = (height - barHeight) / 2;
      const played = count === 0 ? 0 : index / count;
      context.fillStyle = played <= progress ? "#00F2FE" : "#2A3444";
      context.beginPath();
      context.roundRect(x, y, barWidth, barHeight, 2);
      context.fill();
    });
  }, [peaks, progress]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      data-testid="waveform"
      role="img"
      aria-label="Audio waveform"
    />
  );
}
