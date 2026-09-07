import type { PinnedEmbeddingArtifact } from "../types/embedding-artifact-types.js";
import { DEFAULT_EMBEDDING_MODEL } from "../types/config-types.js";

// The pinned revision and checksums were recorded from the model repository at
// pin time. Changing either is a deliberate supply-chain decision (see the
// embedding supply-chain risk in the design document), never a casual update.
export const PINNED_EMBEDDING_MODEL_ID = DEFAULT_EMBEDDING_MODEL;
export const PINNED_EMBEDDING_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const PINNED_EMBEDDING_DTYPE = "q8";
export const PINNED_EMBEDDING_ARTIFACT_BASE_URL = `https://huggingface.co/${PINNED_EMBEDDING_MODEL_ID}/resolve/${PINNED_EMBEDDING_MODEL_REVISION}`;

export const PINNED_EMBEDDING_ARTIFACTS: ReadonlyArray<PinnedEmbeddingArtifact> = [
  { path: "config.json", sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7" },
  { path: "onnx/model_quantized.onnx", sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1" },
  { path: "special_tokens_map.json", sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3" },
  { path: "tokenizer.json", sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
  { path: "tokenizer_config.json", sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
  { path: "vocab.txt", sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
];
