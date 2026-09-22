import Link from "next/link";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}) {
  return (
    <div>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <ul className="breadcrumbs">
          {breadcrumbs.map((b, i) => (
            <li key={i}>{b.href ? <Link href={b.href}>{b.label}</Link> : b.label}</li>
          ))}
        </ul>
      )}
      <div className="page-header">
        <div className="page-header-text">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </div>
  );
}
