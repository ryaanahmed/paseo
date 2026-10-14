import { describe, expect, test } from "vitest";
import { DirectorySyncService } from "./index.js";

function project(projectId: string, name: string) {
  return {
    projectId,
    projectDisplayName: name,
    projectRootPath: `/${projectId}`,
    projectKind: "git" as const,
  };
}

describe("DirectorySyncService", () => {
  test("owns sequencing and returns wire-ready latest project changes", () => {
    const service = new DirectorySyncService("generation");
    expect(service.synchronizeProjects([project("one", "One")], {}).sync).toMatchObject({
      mode: "snapshot",
      headSeq: 1,
    });

    service.sequenceProjectUpdate({ kind: "upsert", project: project("one", "Renamed") }, true);
    service.sequenceProjectUpdate({ kind: "upsert", project: project("one", "Latest") }, true);
    expect(
      service.synchronizeProjects([project("one", "Latest")], {
        generation: "generation",
        afterSeq: 1,
      }),
    ).toEqual({
      projects: [{ ...project("one", "Latest"), syncSeq: 3 }],
      sync: { generation: "generation", mode: "changes", headSeq: 3, removals: [] },
    });
  });

  test("sequences a hard project removal once", () => {
    const service = new DirectorySyncService("generation");
    service.synchronizeProjects([project("one", "One")], {});
    const update = { kind: "remove" as const, projectId: "one" };
    expect(service.sequenceProjectUpdate(update, true)).toEqual({
      ...update,
      generation: "generation",
      seq: 2,
    });
    expect(service.sequenceProjectUpdate(update, true)).toEqual({
      ...update,
      generation: "generation",
      seq: 2,
    });
    expect(
      service.synchronizeProjects([], { generation: "generation", afterSeq: 1 }).sync.removals,
    ).toEqual([{ id: "one", seq: 2 }]);
  });

  test("keeps one daemon-wide version for repeated observations", () => {
    const service = new DirectorySyncService("generation");
    const update = { kind: "upsert" as const, project: project("one", "One") };
    const sequenced = { ...update, generation: "generation", seq: 1 };
    expect(service.sequenceProjectUpdate(update, true)).toEqual(sequenced);
    expect(service.sequenceProjectUpdate(update, true)).toEqual(sequenced);
  });

  test("sequences only the project whose effective icon changed", () => {
    const service = new DirectorySyncService("generation");
    const one = { ...project("one", "One"), projectIconRevision: "icon-a" };
    const two = { ...project("two", "Two"), projectIconRevision: "icon-a" };
    service.synchronizeProjects([one, two], {});
    const changed = { ...one, projectIconRevision: "icon-b" };
    service.sequenceProjectUpdate({ kind: "upsert", project: changed }, true);

    expect(
      service.synchronizeProjects([changed, two], {
        generation: "generation",
        afterSeq: 2,
      }),
    ).toEqual({
      projects: [{ ...changed, syncSeq: 3 }],
      sync: { generation: "generation", mode: "changes", headSeq: 3, removals: [] },
    });
  });

  test("falls back to a snapshot when the daemon generation changes", () => {
    const service = new DirectorySyncService("new-generation");
    const read = service.synchronizeProjects([project("one", "One")], {
      generation: "old-generation",
      afterSeq: 10,
    });
    expect(read.sync).toMatchObject({
      mode: "snapshot",
      reason: "generation_changed",
      headSeq: 1,
    });
  });
  test("keeps background projects in the canonical collection across scoped reads and live projection", () => {
    const service = new DirectorySyncService("generation");
    const hidden = { ...project("worker", "Worker"), background: true };
    const visible = project("human", "Human");
    const snapshot = [hidden, visible];
    const normal = service.synchronizeProjects(snapshot, {});
    expect(normal.projects.map((entry) => entry.projectId)).toEqual(["human"]);
    expect(normal.sync.removals).toEqual([{ id: "worker", seq: 1 }]);
    const inclusive = service.synchronizeProjects(snapshot, normal.sync, true);
    expect(inclusive.projects.map((entry) => entry.projectId)).toEqual(["worker", "human"]);
    expect(inclusive.sync).toMatchObject({ generation: "generation:background", mode: "snapshot" });
    const unchanged = service.synchronizeProjects(snapshot, {
      generation: normal.sync.generation,
      afterSeq: normal.sync.headSeq,
    });
    expect(unchanged.projects).toEqual([]);
    expect(unchanged.sync.removals).toEqual([]);

    const update = service.sequenceProjectUpdate({ kind: "upsert", project: hidden }, true);
    expect(service.projectUpdateForScope(update, false)).toEqual({
      kind: "remove",
      projectId: "worker",
      seq: 1,
      generation: "generation",
    });
    expect(service.projectUpdateForScope(update, true)).toMatchObject({
      kind: "upsert",
      project: hidden,
      seq: 1,
      generation: "generation:background",
    });
    const promoted = { ...hidden, background: false };
    service.sequenceProjectUpdate({ kind: "upsert", project: promoted }, true);
    const changes = service.synchronizeProjects([promoted, visible], {
      generation: normal.sync.generation,
      afterSeq: normal.sync.headSeq,
    });
    expect(changes.projects).toEqual([{ ...promoted, syncSeq: 3 }]);
    expect(changes.sync.removals).toEqual([]);
  });
});
