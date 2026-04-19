'use client';

import { useState } from 'react';
import { Images, ZoomIn, X, Monitor } from 'lucide-react';

export default function SlideGallery({ slides }) {
  const [selected, setSelected] = useState(null);

  if (slides.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Monitor className="w-10 h-10 text-white/15 mb-3" />
        <p className="text-sm text-white/30">Screen frames will appear here</p>
        <p className="text-[11px] text-white/20 mt-1">Captured every 30 seconds — slide changes detected by AI</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <div className="flex items-center gap-2 flex-shrink-0">
        <Images className="w-4 h-4 text-accent-cyan" />
        <h2 className="text-sm font-semibold text-white/80">Visual Gallery</h2>
        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-accent-cyan/20 text-accent-cyan">
          {slides.length} slides
        </span>
      </div>

      {/* Thumbnail grid */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          {slides.map((slide, idx) => (
            <div
              key={slide.id || idx}
              className="slide-thumb cursor-pointer group"
              onClick={() => setSelected(slide)}
              role="button"
              aria-label={`View slide ${idx + 1}`}
            >
              {/* Thumbnail image */}
              <img
                src={`data:image/jpeg;base64,${slide.frame}`}
                alt={slide.description || `Slide ${idx + 1}`}
                className="w-full h-full object-cover"
              />

              {/* Overlay on hover */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <ZoomIn className="w-5 h-5 text-white" />
              </div>

              {/* Bottom caption */}
              <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                <p className="text-[10px] text-white/80 line-clamp-2 leading-tight">
                  {slide.description || 'Slide captured'}
                </p>
                {slide.captured_at && (
                  <p className="text-[9px] text-white/40 mt-0.5">
                    {new Date(slide.captured_at).toLocaleTimeString()}
                  </p>
                )}
              </div>

              {/* Slide #badge */}
              <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-[9px] text-white/70 font-mono">
                #{slides.length - idx}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-8 animate-fade-in"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Slide lightbox"
        >
          <div
            className="relative max-w-5xl w-full glass-card overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelected(null)}
              className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-black/60 flex items-center justify-center text-white/60 hover:text-white transition-colors"
              aria-label="Close lightbox"
            >
              <X className="w-4 h-4" />
            </button>

            <img
              src={`data:image/jpeg;base64,${selected.frame}`}
              alt={selected.description || 'Slide'}
              className="w-full h-auto rounded-xl"
            />

            {selected.description && (
              <div className="p-4 border-t border-white/5">
                <p className="text-sm text-white/80 leading-relaxed">{selected.description}</p>
                {selected.key_points && selected.key_points.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {selected.key_points.map((point, i) => (
                      <li key={i} className="text-xs text-white/50 flex items-start gap-2">
                        <span className="text-brand-400 mt-0.5">•</span>
                        {point}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
