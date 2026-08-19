import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  THEME_PRESETS,
  type ThemePreset,
  type ThemeSwatch,
} from "@/lib/theme";

function MiniAppChromePreview({
  swatch,
  gradients,
}: {
  swatch: ThemeSwatch;
  gradients: boolean;
}) {
  const contentBg = gradients && swatch.gradient ? swatch.gradient : swatch.bg;
  const sidebarBg = `color-mix(in srgb, ${swatch.bg} 82%, ${swatch.primary})`;
  const titlebarBg = `color-mix(in srgb, ${swatch.bg} 70%, ${swatch.primary})`;
  const lineColor = `color-mix(in srgb, ${swatch.fg} 22%, transparent)`;
  const lineShort = `color-mix(in srgb, ${swatch.fg} 14%, transparent)`;

  return (
    <span
      className="flex aspect-[5/3.5] w-full flex-col overflow-hidden rounded border border-black/10 shadow-sm"
      aria-hidden="true"
    >
      <span
        className="flex h-[18%] shrink-0 items-center gap-[3px] px-1"
        style={{ background: titlebarBg, color: swatch.fg }}
      >
        <span
          className="size-[5px] shrink-0 rounded"
          style={{ background: swatch.primary }}
        />
        <span
          className="h-[3px] flex-1 rounded-full opacity-35"
          style={{ background: swatch.fg }}
        />
      </span>
      <span className="flex min-h-0 flex-1">
        <span
          className="flex w-[30%] shrink-0 flex-col gap-[3px] p-[3px]"
          style={{ background: sidebarBg }}
        >
          <span
            className="h-[3px] w-full rounded-full opacity-25"
            style={{ background: swatch.fg }}
          />
          <span
            className="flex h-[5px] items-center rounded px-[2px]"
            style={{ background: `color-mix(in srgb, ${swatch.primary} 28%, transparent)` }}
          >
            <span
              className="size-[3px] rounded-full"
              style={{ background: swatch.primary }}
            />
          </span>
          <span
            className="h-[3px] w-4/5 rounded-full opacity-20"
            style={{ background: swatch.fg }}
          />
          <span
            className="h-[3px] w-3/5 rounded-full opacity-15"
            style={{ background: swatch.fg }}
          />
        </span>
        <span
          className="flex min-w-0 flex-1 flex-col gap-[3px] p-[3px]"
          style={{ background: contentBg, color: swatch.fg }}
        >
          <span
            className="h-[4px] w-[55%] rounded-full"
            style={{ background: lineColor }}
          />
          <span
            className="h-[3px] w-full rounded-full"
            style={{ background: lineShort }}
          />
          <span
            className="h-[3px] w-[85%] rounded-full"
            style={{ background: lineShort }}
          />
          <span
            className="mt-auto h-[5px] w-[40%] rounded"
            style={{ background: `color-mix(in srgb, ${swatch.primary} 35%, transparent)` }}
          />
        </span>
      </span>
    </span>
  );
}

export function ThemePresetPicker({
  value,
  mode,
  gradients = true,
  onChange,
}: {
  value: ThemePreset;
  mode: "light" | "dark";
  gradients?: boolean;
  onChange: (preset: ThemePreset) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Bộ màu"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
    >
      {THEME_PRESETS.map((preset) => {
        const selected = value === preset.id;
        const swatch = mode === "dark" ? preset.dark : preset.light;

        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            title={preset.description}
            aria-label={`${preset.label}. ${preset.description}`}
            aria-checked={selected}
            onClick={() => onChange(preset.id)}
            className={cn(
              "group relative flex flex-col gap-1 rounded-lg bg-surface-gradient p-1.5 text-left transition-all hover:brightness-105",
              selected && "interactive-surface-active",
            )}
          >
            <MiniAppChromePreview swatch={swatch} gradients={gradients} />
            <span className="flex items-center justify-between gap-1 px-0.5">
              <span className="truncate text-[11px] font-medium leading-tight">
                {preset.label}
              </span>
              {selected && (
                <CheckIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 text-primary"
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
