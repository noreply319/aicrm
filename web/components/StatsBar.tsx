import { formatShortWon } from "@/lib/format";
import type { Lead } from "@/lib/types";

export default function StatsBar({ leads }: { leads: Lead[] }) {
  const sum = (arr: Lead[]) => arr.reduce((s, l) => s + (Number(l.value) || 0), 0);
  const active = leads.filter((l) => l.stage !== "won" && l.stage !== "lost");
  const won = leads.filter((l) => l.stage === "won");
  const lost = leads.filter((l) => l.stage === "lost");
  const closed = won.length + lost.length;

  const stats = [
    { label: "전체 리드", value: String(leads.length) },
    { label: "진행 중 파이프라인", value: formatShortWon(sum(active)) },
    { label: "수주 금액", value: formatShortWon(sum(won)) },
    { label: "수주율", value: closed ? Math.round((won.length / closed) * 100) + "%" : "—" },
  ];

  return (
    <section className="stats">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <div className="label">{s.label}</div>
          <div className="value">{s.value}</div>
        </div>
      ))}
    </section>
  );
}
