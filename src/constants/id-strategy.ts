export const IdStrategy = {
  UuidV7: "uuid_v7",
} as const;

export type IdStrategy = (typeof IdStrategy)[keyof typeof IdStrategy];
