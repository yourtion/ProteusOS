export interface PublicationRecord {
  id: string;
  teamId: string;
  scope: string;
  bundleDigest: string;
  bundleRef: string;
  versionIds: string[];
  createdBy: string;
  createdAt: number;
}

export interface SharedVersion {
  id: string;
  artifactId: string;
  kind: string;
  lineageId: string;
  scope: string;
  schemaVersion: number;
  content: string;
  contentDigest: string;
  dependencies: string[];
  /** Only public/team ancestry is disclosed; private origin remains local. */
  parents: Array<{ id: string; contentDigest: string; lineageId: string }>;
  withheldParentCount: number;
}

export interface SharedEvidence {
  protocolDigest: string;
  verdict: "eligible";
  samples: number;
  baseSuccessRate: number | null;
  candidateSuccessRate: number | null;
}

export interface ShareBundle {
  format: "proteus-share-v1";
  publicationId: string;
  teamId: string;
  scope: string;
  publisher: string;
  createdAt: number;
  roots: string[];
  versions: SharedVersion[];
  evidence: SharedEvidence[];
}

export interface ShareEnvelope {
  digest: string;
  bundle: ShareBundle;
}

export interface ImportRecord {
  id: string;
  organismId: string;
  bundleDigest: string;
  bundleRef: string | null;
  publicationId: string;
  versions: Record<string, string>;
  rootVersionIds: string[];
  state: "imported" | "rejected";
  createdBy: string;
  createdAt: number;
}
