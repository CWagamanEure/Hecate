import { describe, it, expect } from "vitest";
import { loadSepoliaDeployment } from "@shared/deployments/sepolia";

describe("Sepolia deployment manifest", () => {
  it("loads and validates against the schema", async () => {
    const d = await loadSepoliaDeployment();
    expect(d.chain_id).toBe(11155111);
    expect(d.chain_name).toBe("sepolia");
  });

  it("pins the V5 contract addresses", async () => {
    const d = await loadSepoliaDeployment();
    expect(d.contracts.HecateVault.address).toBe(
      "0x7EF8583489eEb158bf9233bC7a38e0EC410eF1aA"
    );
    expect(d.contracts.MockUSDC.address).toBe(
      "0x1662B5050B70c8fAc9405d11B3e7eCDe9eF6c3cB"
    );
    expect(d.contracts.HecateSettlementVerifier.address).toBe(
      "0x0bAcD73a36f774Cb7c2f252a2d3c002A0079D4E2"
    );
  });

  it("engine address matches the LOCAL_DEV_KEY derivation", async () => {
    const d = await loadSepoliaDeployment();
    expect(d.engine_address).toBe(
      "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
    );
  });

  it("all contracts are marked verified on Etherscan", async () => {
    const d = await loadSepoliaDeployment();
    expect(d.contracts.HecateVault.verified).toBe(true);
    expect(d.contracts.MockUSDC.verified).toBe(true);
    expect(d.contracts.HecateSettlementVerifier.verified).toBe(true);
  });

  it("demo agent mint amounts match the funding plan", async () => {
    const d = await loadSepoliaDeployment();
    expect(d.demo_agents.A.minted_musdc).toBe("0");
    expect(d.demo_agents.B.minted_musdc).toBe("5000000000");
    expect(d.demo_agents.C.minted_musdc).toBe("5000000000");
    expect(d.demo_agents.D.minted_musdc).toBe("200000000");
  });
});
