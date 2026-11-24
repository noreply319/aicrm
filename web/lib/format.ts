export const formatWon = (n: number) =>
  "₩" + Math.round(n || 0).toLocaleString("ko-KR");

export const formatShortWon = (n: number) => {
  n = n || 0;
  if (n >= 1e8) return "₩" + (n / 1e8).toFixed(1).replace(/\.0$/, "") + "억";
  if (n >= 1e4) return "₩" + Math.round(n / 1e4).toLocaleString("ko-KR") + "만";
  return formatWon(n);
};

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const isOverdue = (closeDate: string) => {
  if (!closeDate) return false;
  const today = new Date(new Date().toDateString());
  return new Date(closeDate) < today;
};

/** ISO → 'YYYY-MM-DD HH:mm' (브라우저 로컬 시간) */
export const formatDateTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** ISO → <input type="datetime-local"> 값 */
export const toLocalInput = (iso: string) => formatDateTime(iso).replace(" ", "T");

/** <input type="datetime-local"> 값 → ISO (잘못된 값이면 "") */
export const fromLocalInput = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};
