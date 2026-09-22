"use client";

/**
 * Mobile-only hamburger: the sidebar itself is server-rendered (it needs
 * session + branding data), so this tiny client island just flips a class
 * on it rather than duplicating the nav markup client-side.
 */
export function SidebarToggle() {
  return (
    <button
      type="button"
      className="sidebar-toggle"
      aria-label="Toggle navigation"
      onClick={() => {
        document.querySelector(".sidebar")?.classList.toggle("open");
        document.querySelector(".sidebar-scrim")?.classList.toggle("visible");
      }}
    >
      ☰
    </button>
  );
}

export function SidebarScrim() {
  return (
    <div
      className="sidebar-scrim"
      onClick={() => {
        document.querySelector(".sidebar")?.classList.remove("open");
        document.querySelector(".sidebar-scrim")?.classList.remove("visible");
      }}
    />
  );
}
