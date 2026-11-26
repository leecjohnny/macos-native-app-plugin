export const spaceCjk = (value: string) =>
  value.replace(/[一-龯ぁ-ヿ가-힣]/g, " $& ");
export function appendWord(previous: { value: string }, word: string) {
  previous.value += " " + word;
}
