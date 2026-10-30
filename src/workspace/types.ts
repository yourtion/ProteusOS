export interface FileArtifact {
  encoding: "base64";
  data: string;
  mode: number;
}
export type FileContent = string | FileArtifact;
export interface Change {
  path: string;
  before: string | null;
  after: string | null;
  beforeFile?: FileArtifact;
  afterFile?: FileArtifact;
}
