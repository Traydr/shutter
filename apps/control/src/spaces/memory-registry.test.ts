import { registerSpaceRegistryContract } from "../../test/space-registry-contract.js";
import { MemorySpaceRegistry } from "./memory-registry.js";

registerSpaceRegistryContract("memory", () => new MemorySpaceRegistry());
