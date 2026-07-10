/**
 * Tiled, semi-transparent watermark of the candidate's name + session across
 * the whole screen. Doesn't block screenshots, but any photo/screenshot carries
 * the candidate's identity — a strong deterrent for medium-stakes exams.
 */
export default function Watermark({ text }) {
  return (
    <div className="watermark" aria-hidden="true">
      {Array.from({ length: 60 }).map((_, i) => (
        <span key={i}>{text}</span>
      ))}
    </div>
  );
}
