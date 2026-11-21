import { useRef, useState } from "react";
import { keyedOccurrences } from "./keyedOccurrences";

/** A local edit can change a row's domain identity without replacing its form controls. */
export function useEditableRowKeys(identities: string[]) {
  const signature = JSON.stringify(identities);
  const [edit, setEdit] = useState<{ signature: string; keys: string[] } | null>(null);
  const sequence = useRef(0);
  const keys = edit?.signature === signature
    ? edit.keys
    : keyedOccurrences(identities, (identity) => identity).map(({ key }) => key);

  return {
    keys,
    rename(index: number, identity: string) {
      if (identities[index] === identity) return;
      const next = identities.slice();
      next[index] = identity;
      setEdit({ signature: JSON.stringify(next), keys });
    },
    remove(index: number) {
      setEdit({
        signature: JSON.stringify(identities.filter((_, i) => i !== index)),
        keys: keys.filter((_, i) => i !== index),
      });
    },
    append(identity: string) {
      setEdit({
        signature: JSON.stringify([...identities, identity]),
        keys: [...keys, `draft:${++sequence.current}`],
      });
    },
  };
}
