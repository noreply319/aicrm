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
