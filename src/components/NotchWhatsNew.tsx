import { X, Sparkles, CalendarDays, Timer, Zap, HeartHandshake } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n";

/** The handful of things worth telling an existing user about, in the order
 *  they are most likely to notice them. Deliberately four short lines: this is
 *  a "welcome back", not the changelog. */
const HIGHLIGHTS: { key: string; icon: ReactNode }[] = [
  { key: "calendar", icon: <CalendarDays size={14} /> },
  { key: "clock", icon: <Timer size={14} /> },
  { key: "ai", icon: <Zap size={14} /> },
  { key: "smooth", icon: <Sparkles size={14} /> },
  { key: "support", icon: <HeartHandshake size={14} /> },
];

interface Props {
  version: string;
  onClose: () => void;
}

export function NotchWhatsNew({ version, onClose }: Props) {
  const t = useT();
  return (
    <div className="whatsnew-content" onClick={(e) => e.stopPropagation()}>
      <div className="whatsnew-head">
        <span className="whatsnew-icon" aria-hidden>
          <Sparkles size={16} />
        </span>
        <div className="whatsnew-heading">
          <span className="whatsnew-title">{t("whatsnew.title")}</span>
          <span className="whatsnew-sub">{t("whatsnew.sub", { version })}</span>
        </div>
        <button className="whatsnew-close" onClick={onClose} aria-label={t("whatsnew.close")}>
          <X size={14} />
        </button>
      </div>

      <ul className="whatsnew-list">
        {HIGHLIGHTS.map((item) => (
          <li key={item.key}>
            <span className="whatsnew-dot" aria-hidden>
              {item.icon}
            </span>
            <span>{t(`whatsnew.${item.key}`)}</span>
          </li>
        ))}
      </ul>

      <div className="whatsnew-foot">
        <span className="whatsnew-hint">{t("whatsnew.hint")}</span>
        <button className="whatsnew-btn" onClick={onClose}>
          {t("whatsnew.done")}
        </button>
      </div>
    </div>
  );
}
