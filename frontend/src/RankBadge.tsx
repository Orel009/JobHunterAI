import type { Rank } from './api';

const CAT: Record<Rank['category'], string> = { junior: 'junior', years2: '2y', years3: '3y', above3: '3y+', unknown: '?' };
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

/** rank with its breakdown: score / experience boost / tier boost */
export function RankBadge({ rank }: { rank: Rank }) {
  if (rank.rank === null) return <span className="score none">–</span>;
  const cls = rank.rank >= 85 ? 'high' : rank.rank >= 65 ? 'mid' : 'low';
  return (
    <span className="rank" title={`score ${rank.score} · experience ${sign(rank.experience)} (${rank.category}) · tier ${sign(rank.tier)}${rank.roleType ? ` (${rank.roleType}, tier ${rank.roleTier})` : ''}`}>
      <span className={`score ${cls}`}>{rank.rank}</span>
      <span className="rank-parts">
        {rank.score} <i>exp</i> {sign(rank.experience)} <i>{CAT[rank.category]}</i> · <i>tier</i> {sign(rank.tier)}
      </span>
    </span>
  );
}
