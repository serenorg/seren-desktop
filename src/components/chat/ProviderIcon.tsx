// ABOUTME: Brand marks for chat providers and external-agent runtimes.
// ABOUTME: Keeps provider identity consistent across launchers and selectors.

import type { Component } from "solid-js";
import serenLogo from "@/assets/logo.svg";

interface Props {
  /** Provider or agent identifier. Unknown ids receive a neutral fallback. */
  provider: string;
  /** Square icon size in pixels. */
  size?: number;
  label?: string;
}

const GLYPHS: Record<string, string> = {
  seren: "S",
  "seren-private": "S",
  anthropic: "A",
  "claude-code": "A",
  openai: "O",
  codex: "O",
  gemini: "G",
  grok: "X",
  "claude-codex": "A+O",
  lmstudio: "LM",
};

export function providerGlyph(provider: string): string {
  return GLYPHS[provider] ?? "AI";
}

const ANTHROPIC_PATH =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const GEMINI_PATH =
  "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";
const XAI_PATH =
  "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z";
const LM_STUDIO_PATH =
  "M5.6 0A5.6 5.6 0 0 0 0 5.6v12.8A5.6 5.6 0 0 0 5.6 24h12.8a5.6 5.6 0 0 0 5.6-5.6V5.6A5.6 5.6 0 0 0 18.4 0zm0 2h12.8A3.6 3.6 0 0 1 22 5.6v12.8a3.6 3.6 0 0 1-3.6 3.6H5.6A3.6 3.6 0 0 1 2 18.4V5.6A3.6 3.6 0 0 1 5.6 2m-.4 2.8a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm-3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4z";

const SvgMark: Component<{ path: string; size: number }> = (props) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    width={props.size}
    height={props.size}
    fill="currentColor"
  >
    <path d={props.path} />
  </svg>
);

const SerenMark: Component<{ size: number; private?: boolean }> = (props) => (
  <span class="relative inline-flex shrink-0 items-center justify-center">
    <img
      aria-hidden="true"
      src={serenLogo}
      width={props.size}
      height={props.size}
      alt=""
      class="object-contain"
    />
    {props.private ? (
      <span class="absolute -bottom-1 -right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full border border-slate-950 bg-cyan-200 text-[7px] leading-none text-slate-950">
        ▪
      </span>
    ) : null}
  </span>
);

function brandMark(provider: string, size: number) {
  switch (provider) {
    case "seren":
      return <SerenMark size={size} />;
    case "seren-private":
      return <SerenMark size={size} private />;
    case "anthropic":
    case "claude-code":
      return <SvgMark path={ANTHROPIC_PATH} size={size} />;
    case "openai":
    case "codex":
      return <SvgMark path={OPENAI_PATH} size={size} />;
    case "gemini":
      return <SvgMark path={GEMINI_PATH} size={size} />;
    case "grok":
      return <SvgMark path={XAI_PATH} size={size} />;
    case "lmstudio":
      return <SvgMark path={LM_STUDIO_PATH} size={size} />;
    case "claude-codex":
      return (
        <span class="inline-flex items-center">
          <SvgMark path={ANTHROPIC_PATH} size={Math.max(10, size - 2)} />
          <span class="-ml-1 rounded-full bg-background p-0.5">
            <SvgMark path={OPENAI_PATH} size={Math.max(10, size - 2)} />
          </span>
        </span>
      );
    default:
      return (
        <span class="font-mono text-[9px] font-semibold leading-none">
          {providerGlyph(provider)}
        </span>
      );
  }
}

export const ProviderIcon: Component<Props> = (props) => {
  const size = () => props.size ?? 14;
  return (
    <span
      role="img"
      aria-label={props.label ?? props.provider}
      class="inline-flex shrink-0 items-center justify-center"
      style={{ width: `${size()}px`, height: `${size()}px` }}
    >
      {brandMark(props.provider, size())}
    </span>
  );
};
