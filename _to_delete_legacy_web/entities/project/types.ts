/**
 * Project entity – shared types.
 */
export interface ProjectEntity {
  id: string;
  name: string;
  entryPath: string | null;
  backend: string;
  createdAt: string | null;
}
