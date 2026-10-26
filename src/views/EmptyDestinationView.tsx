const COPY: Record<string, { title: string; lede: string }> = {
  review: {
    title: "Review",
    lede: "Review drafts and Tippy suggestions will settle here. Nothing to check yet.",
  },
  planner: {
    title: "Planner",
    lede: "Content planning stays calm and empty until the next phase lands.",
  },
  analytics: {
    title: "Analytics",
    lede: "Performance insights will appear here without crowding the creative loop.",
  },
  library: {
    title: "Library",
    lede: "Saved clips and media will live in this quiet shelf when ready.",
  },
  brand: {
    title: "Brand Kit",
    lede: "Brand colors, fonts, and assets will sit here once connected.",
  },
};

interface EmptyDestinationViewProps {
  id: keyof typeof COPY;
}

export function EmptyDestinationView({ id }: EmptyDestinationViewProps) {
  const copy = COPY[id];
  return (
    <section className="workspace">
      <div className="panel empty-destination">
        <p className="eyebrow">Coming soon</p>
        <h1>{copy.title}</h1>
        <p className="lede">{copy.lede}</p>
      </div>
    </section>
  );
}
