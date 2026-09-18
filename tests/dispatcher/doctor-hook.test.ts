import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStructuredDoctorDiagnosis,
  isQualityDoctorDiagnosisTask,
} from "../../src/dispatcher";
import { isEnvironmentFixTask } from "../../src/dispatcher/environment-fix";
import * as regularDoctor from "../../src/doctor";
import * as qualityDoctor from "../../src/quality/doctor";

vi.mock("../../src/doctor", () => ({
  parseDoctorDiagnosis: vi.fn(),
  applyDoctorDiagnosis: vi.fn(),
  escalateMalformedDiagnosis: vi.fn(),
}));

vi.mock("../../src/quality/doctor", () => ({
  parseQualityDoctorDiagnosis: vi.fn(),
  parseQualityDoctorDiagnosisResult: vi.fn(),
  applyQualityDoctorDiagnosis: vi.fn(),
  recordQualityDoctorContaminationHandoff: vi.fn(),
}));

/**
 * The dispatcher only applies a structured doctor diagnosis when the task is
 * a diagnostic doctor child, not any doctor-authored repair task.
 *
 * Mirrors the condition at src/dispatcher/index.ts. Pinned here so
 * future refactors don't accidentally broaden the hook (which would
 * apply diagnoses against environment-fix tasks — catastrophic)
 * or narrow it (which would silently skip real doctor tasks).
 */
function shouldApplyDoctorHook(task: {
  assignedTo: string;
  createdBy: string;
  parentTaskId: string | null;
  title: string;
}): boolean {
  return task.assignedTo === "doctor"
    && !!task.parentTaskId
    && (task.createdBy === "dispatcher" || task.title.includes("Quality diagnosis:"))
    && !isEnvironmentFixTask({
      assignedTo: task.assignedTo,
      title: task.title,
      parentTaskId: task.parentTaskId,
    });
}

describe("dispatcher doctor-hook gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires for a doctor task with a parent", () => {
    expect(
      shouldApplyDoctorHook({
        assignedTo: "doctor",
        createdBy: "dispatcher",
        parentTaskId: "00000000-0000-4000-8000-000000000001",
        title: "[Doctor] Diagnose: something",
      }),
    ).toBe(true);
  });

  it("does NOT fire for an environment-fix task even when linked to a parent", () => {
    expect(shouldApplyDoctorHook({
      assignedTo: "doctor",
      createdBy: "doctor",
      parentTaskId: "00000000-0000-4000-8000-000000000001",
      title: "Fix environment for: 00000000-0000-4000-8000-000000000001",
    })).toBe(false);
  });

  it("does NOT fire for a retried environment-fix task", () => {
    expect(shouldApplyDoctorHook({
      assignedTo: "doctor",
      createdBy: "dispatcher",
      parentTaskId: "00000000-0000-4000-8000-000000000001",
      title: "[Doctor retry: auto] Fix environment for: 00000000-0000-4000-8000-000000000001",
    })).toBe(false);
  });

  it("does NOT fire for a non-doctor task with a parent (e.g. split subtask)", () => {
    expect(
      shouldApplyDoctorHook({
        assignedTo: "dev-agent",
        createdBy: "dispatcher",
        parentTaskId: "00000000-0000-4000-8000-000000000001",
        title: "ordinary child task",
      }),
    ).toBe(false);
  });

  it("does NOT fire for a regular task", () => {
    expect(shouldApplyDoctorHook({
      assignedTo: "dev-agent",
      createdBy: "owner",
      parentTaskId: null,
      title: "ordinary task",
    })).toBe(false);
  });

  it("routes retried quality-doctor tasks to the quality parser", async () => {
    const diagnosis = {
      contract: "quality_doctor_diagnosis.v1",
      cause: "wrong_role_or_brief",
      details: "QA was asked to diagnose its own already-shipped verdict.",
      recommendation: "Send to supervisor for a clearer review brief.",
    } as const;
    const sql = {} as never;
    vi.mocked(qualityDoctor.parseQualityDoctorDiagnosisResult).mockReturnValue({ ok: true, diagnosis });

    const handled = await applyStructuredDoctorDiagnosis(sql, {
      assignedTo: "doctor",
      createdBy: "dispatcher",
      id: "399226f6-0000-0000-0000-000000000000",
      parentTaskId: "46c6df57-0000-0000-0000-000000000000",
      title: "[Doctor retry: claude-code] Quality diagnosis: QA review",
    }, "doctor output");

    expect(handled).toBe(true);
    expect(qualityDoctor.parseQualityDoctorDiagnosisResult).toHaveBeenCalledWith("doctor output");
    expect(qualityDoctor.applyQualityDoctorDiagnosis).toHaveBeenCalledWith(
      sql,
      "46c6df57-0000-0000-0000-000000000000",
      diagnosis,
    );
    expect(regularDoctor.parseDoctorDiagnosis).not.toHaveBeenCalled();
  });

  it("does not fall through to regular doctor parsing when a quality retry emits contaminated SupervisorActions output", async () => {
    const sql = {} as never;
    vi.mocked(qualityDoctor.parseQualityDoctorDiagnosisResult).mockReturnValue({
      ok: false,
      kind: "contaminated",
      reason: "Quality doctor output used non-quality diagnosis field 'action'.",
    });

    const handled = await applyStructuredDoctorDiagnosis(sql, {
      assignedTo: "doctor",
      createdBy: "quality-doctor",
      id: "399226f6-0000-0000-0000-000000000000",
      parentTaskId: "46c6df57-0000-0000-0000-000000000000",
      title: "Quality diagnosis: QA review",
    }, "```json\n{\"action\":\"rewrite_brief\",\"newBrief\":\"stale\"}\n```");

    expect(handled).toBe(true);
    expect(qualityDoctor.recordQualityDoctorContaminationHandoff).toHaveBeenCalledWith(
      sql,
      "46c6df57-0000-0000-0000-000000000000",
      "399226f6-0000-0000-0000-000000000000",
      "Quality doctor output used non-quality diagnosis field 'action'.",
      "```json\n{\"action\":\"rewrite_brief\",\"newBrief\":\"stale\"}\n```",
    );
    expect(qualityDoctor.applyQualityDoctorDiagnosis).not.toHaveBeenCalled();
    expect(regularDoctor.parseDoctorDiagnosis).not.toHaveBeenCalled();
    expect(regularDoctor.applyDoctorDiagnosis).not.toHaveBeenCalled();
  });

  it("still recognizes the original quality-doctor task shape", () => {
    expect(
      isQualityDoctorDiagnosisTask({
        createdBy: "quality-doctor",
        title: "Quality diagnosis: QA review",
      }),
    ).toBe(true);
  });
});
