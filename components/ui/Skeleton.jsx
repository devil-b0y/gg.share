// Placeholder cards shown while the first page of the feed loads.

function SkeletonCard() {
  return (
    <div className="skeleton">
      <div className="sk-head">
        <div className="sk-bone circle sk-shimmer" style={{ width: 30, height: 30 }} />
        <div style={{ flex: 1 }}>
          <div className="sk-bone sk-shimmer" style={{ width: 110, height: 10, marginBottom: 6 }} />
          <div className="sk-bone sk-shimmer" style={{ width: 60, height: 8 }} />
        </div>
      </div>
      <div className="sk-bone sk-shimmer" style={{ height: 300, borderRadius: 0 }} />
      <div style={{ padding: '12px 13px' }}>
        <div className="sk-bone sk-shimmer" style={{ width: '70%', height: 10 }} />
      </div>
    </div>
  );
}

export default function Skeleton({ count = 3 }) {
  return Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />);
}
