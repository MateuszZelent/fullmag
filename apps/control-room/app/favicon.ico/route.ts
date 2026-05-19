const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#101722"/>
  <path d="M7 22V8h18v4H12v3h10v4H12v3H7Z" fill="#7dd3fc"/>
  <path d="M19 24c3.314 0 6-2.239 6-5s-2.686-5-6-5" fill="none" stroke="#facc15" stroke-width="3" stroke-linecap="round"/>
</svg>`;

export const dynamic = "force-static";

export function GET() {
  return new Response(ICON_SVG, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
}
