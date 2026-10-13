import type { ReactNode } from "react";

type IconProps = { className?: string };

function Stroke({
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg className={className ?? "icon"} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconHome(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5.2v-6.2H10.2V21H5a1 1 0 0 1-1-1z" />
    </Stroke>
  );
}

export function IconProjects(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M3.5 7.5h6l1.6 2H20.5V19a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19z" />
      <path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4.2L11 6" />
    </Stroke>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M12 5v14M5 12h14" />
    </Stroke>
  );
}

export function IconReview(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="m8.5 12.2 2.3 2.3 4.7-5" />
    </Stroke>
  );
}

export function IconPlanner(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </Stroke>
  );
}

export function IconAnalytics(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 19h16" />
      <path d="M7 16V11M12 16V7M17 16v-5" />
    </Stroke>
  );
}

export function IconLibrary(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M6 5h9.5A2.5 2.5 0 0 1 18 7.5V19H8.5A2.5 2.5 0 0 1 6 16.5z" />
      <path d="M6 5.5A2.5 2.5 0 0 0 3.5 8V18" />
    </Stroke>
  );
}

export function IconBrand(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M12 3.5 14.2 9H20l-4.6 3.4L17.2 18 12 14.8 6.8 18l1.8-5.6L4 9h5.8z" />
    </Stroke>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="8.5" r="3" />
      <path d="M5.5 19.2c1.2-2.8 3.4-4.2 6.5-4.2s5.3 1.4 6.5 4.2" />
    </Stroke>
  );
}
