import Link from "next/link";

export function Footer() {
  return (
    <footer className="flex h-[var(--footer-height)] items-center justify-between border-t border-border/50 px-6 text-xs text-muted-foreground">
      <span className="truncate">
        Fullmag &middot; Physics-first micromagnetics platform
      </span>
      <span className="ml-4 shrink-0">
        <Link
          href="https://github.com/MateuszZelent/fullmag"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
        >
          GitHub
        </Link>
        {" · "}
        <Link href="/docs/physics" className="transition-colors hover:text-foreground">
          Physics Docs
        </Link>
      </span>
    </footer>
  );
}
