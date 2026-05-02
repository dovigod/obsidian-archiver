export const AutonomyAction = {
  CreateEntity: "create_entity",
  UpdateEntity: "update_entity",
  AddToIndex: "add_to_index",
  SplitCategory: "split_category",
  MergeEntities: "merge_entities",
  RenameEntity: "rename_entity",
  DeletePage: "delete_page",
} as const;

export type AutonomyAction =
  (typeof AutonomyAction)[keyof typeof AutonomyAction];
