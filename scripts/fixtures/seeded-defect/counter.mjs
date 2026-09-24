export function initialCount() {
  return 0;
}

export function bump(count, step = 1) {
  return count + step;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(initialCount());
}
