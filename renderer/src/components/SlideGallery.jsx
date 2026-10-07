'use client';
import { Monitor } from 'lucide-react';
export default function SlideGallery({ slides }) {
  return <><div className="card-heading"><div><h2>Slide context</h2><p>Content captured from shared screens in the desktop app.</p></div><Monitor size={20} /></div>
    {!slides.length ? <div className="empty-state"><Monitor size={28} /><h3>No slides captured</h3><p>Use the desktop app with live AI enabled to analyze presentation slides.</p></div> : <div className="slide-grid">{slides.map((slide, index) => <article className="slide-card" key={slide.id || index}>{(slide.frame || slide.frame_b64) && <img src={`data:image/jpeg;base64,${slide.frame || slide.frame_b64}`} alt={slide.description || 'Captured slide'} />}<h3>{slide.description || `Slide ${index + 1}`}</h3><ul>{(slide.key_points || []).map((point, i) => <li key={i}>{point}</li>)}</ul>{slide.takeaway && <p>{slide.takeaway}</p>}</article>)}</div>}
  </>;
}
