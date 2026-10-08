import { Sparkles } from 'lucide-react';

/** סמל המטמיעון — משותף לסרגל הצד ולמסכי ההזדהות */
export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <Sparkles />
    </div>
  );
}

export const APP_NAME = 'המטמיעון';

export function Brand({ sub }) {
  return (
    <div className="brand">
      <BrandMark />
      <div>
        <div className="brand-title">{APP_NAME}</div>
        {sub && <div className="brand-sub">{sub}</div>}
      </div>
    </div>
  );
}
