import { describe, it, expect, beforeEach } from "vitest";
import { GET as getHives } from "@/app/api/hives/route";
import { GET as getTasks, POST as createTask } from "@/app/api/tasks/route";
import { GET as getTaskById } from "@/app/api/tasks/[id]/route";
import { testSql as db, truncateAll } from "../_lib/test-db";

const TEST_PREFIX = "p5-api-";

let testHiveId: string;
let testTaskId: string;

beforeEach(async () => {
  await truncateAll(db);

  // Create a test hive
  const [biz] = await db`
    INSERT INTO hives (slug, name, type, description)
    VALUES (${TEST_PREFIX + "biz"}, ${TEST_PREFIX + "Test Hive"}, 'service', 'Test hive for API tests')
    RETURNING id
  `;
  testHiveId = biz.id;

  // Create a task so tests that reference testTaskId have it
  const [task] = await db`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, qa_required)
    VALUES (${testHiveId}, 'dev-agent', 'test-runner', ${TEST_PREFIX + "Build widget"}, 'Build the main widget component', 3, true)
    RETURNING id
  `;
  testTaskId = task.id;
});

describe("GET /api/hives", () => {
  it("returns list of hives", async () => {
    const res = await getHives(new Request("http://localhost:3000/api/hives"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    // Should contain our test hive
    const found = body.data.find((b: { slug: string }) => b.slug === TEST_PREFIX + "biz");
    expect(found).toBeDefined();
    expect(found.name).toBe(TEST_PREFIX + "Test Hive");
    expect(found).toHaveProperty("createdAt");
  });
});

function taskCreateRequest(body: object, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks", () => {
  it("creates a task and returns 201", async () => {
    const req = taskCreateRequest({
      hiveId: testHiveId,
      assignedTo: "dev-agent",
      title: TEST_PREFIX + "New task via API",
      brief: "Another task created via the API",
      priority: 2,
      qaRequired: false,
      createdBy: "test-runner",
    });
    const res = await createTask(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.title).toBe(TEST_PREFIX + "New task via API");
    expect(body.data.assignedTo).toBe("dev-agent");
    expect(body.data.priority).toBe(2);
    expect(body.data.qaRequired).toBe(false);
    expect(body.data.status).toBe("pending");
  });

  it("links replacement tasks to sourceTaskId", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Recovery goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Failed source', 'Original work', 'failed')
      RETURNING id
    `;

    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: TEST_PREFIX + "Replacement task",
        brief: "Bounded replacement work",
        goalId: goal.id,
        sourceTaskId: sourceTask.id,
        createdBy: "goal-supervisor",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.parentTaskId).toBe(sourceTask.id);
  });

  it("blocks replacement tasks when the source task family budget is exhausted", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Budgeted recovery goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Budget source', 'Original work', 'failed')
      RETURNING id
    `;
    for (let i = 1; i <= 3; i += 1) {
      await db`
        INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
        VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`Existing replacement ${i}`}, 'Recovery work', 'failed', ${sourceTask.id})
      `;
    }

    const req = taskCreateRequest({
      hiveId: testHiveId,
      assignedTo: "dev-agent",
      title: TEST_PREFIX + "Blocked replacement task",
      brief: "This should not be created",
      goalId: goal.id,
      sourceTaskId: sourceTask.id,
      createdBy: "goal-supervisor",
    });

    const res = await createTask(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Recovery budget exhausted");

    const created = await db`
      SELECT id FROM tasks WHERE title = ${TEST_PREFIX + "Blocked replacement task"}
    `;
    expect(created).toHaveLength(0);

    const [parked] = await db`
      SELECT status, failure_reason FROM tasks WHERE id = ${sourceTask.id}
    `;
    expect(parked.status).toBe("unresolvable");
    expect(parked.failure_reason).toContain("replacement tasks");
  });

  it("retries an idempotent replacement after a stale budget failure is cleared", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Retryable recovery budget goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Retryable budget source', 'Original work', 'failed')
      RETURNING id
    `;
    for (let i = 1; i <= 3; i += 1) {
      await db`
        INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
        VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`Retryable existing replacement ${i}`}, 'Recovery work', 'failed', ${sourceTask.id})
      `;
    }

    const body = {
      hiveId: testHiveId,
      assignedTo: "dev-agent",
      title: TEST_PREFIX + "Retryable replacement task",
      brief: "This should be created after budget is cleared",
      goalId: goal.id,
      sourceTaskId: sourceTask.id,
      createdBy: "goal-supervisor",
    };
    const headers = { "Idempotency-Key": "tasks-retry-after-budget-clear" };

    const blocked = await createTask(taskCreateRequest(body, headers));
    const blockedBody = await blocked.json();

    expect(blocked.status).toBe(409);
    expect(blockedBody.error).toContain("Recovery budget exhausted");

    const storedAfterFailure = await db`
      SELECT key FROM idempotency_keys WHERE key = ${headers["Idempotency-Key"]}
    `;
    expect(storedAfterFailure).toHaveLength(0);

    await db`
      DELETE FROM tasks
      WHERE title = 'Retryable existing replacement 3'
    `;
    await db`
      UPDATE tasks
      SET status = 'failed', failure_reason = NULL
      WHERE id = ${sourceTask.id}
    `;

    const retry = await createTask(taskCreateRequest(body, headers));
    const retryBody = await retry.json();

    expect(retry.status).toBe(201);
    expect(retryBody.data.parentTaskId).toBe(sourceTask.id);
    expect(retryBody.data.title).toBe(TEST_PREFIX + "Retryable replacement task");

    const replacements = await db`
      SELECT id FROM tasks WHERE parent_task_id = ${sourceTask.id}
    `;
    expect(replacements).toHaveLength(3);
  });

  it("replays an idempotent replacement response without re-running budget mutation", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Idempotent recovery goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Idempotent budget source', 'Original work', 'failed')
      RETURNING id
    `;
    for (let i = 1; i <= 2; i += 1) {
      await db`
        INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
        VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`Idempotent existing replacement ${i}`}, 'Recovery work', 'failed', ${sourceTask.id})
      `;
    }

    const body = {
      hiveId: testHiveId,
      assignedTo: "dev-agent",
      title: TEST_PREFIX + "Idempotent replacement task",
      brief: "This should be created once and replayed",
      goalId: goal.id,
      sourceTaskId: sourceTask.id,
      createdBy: "goal-supervisor",
    };

    const first = await createTask(taskCreateRequest(body, { "Idempotency-Key": "tasks-retry-once" }));
    const firstBody = await first.json();
    const retry = await createTask(taskCreateRequest(body, { "Idempotency-Key": "tasks-retry-once" }));
    const retryBody = await retry.json();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retryBody).toEqual(firstBody);

    const replacements = await db`
      SELECT id FROM tasks WHERE parent_task_id = ${sourceTask.id}
    `;
    expect(replacements).toHaveLength(3);

    const [source] = await db`
      SELECT status, failure_reason FROM tasks WHERE id = ${sourceTask.id}
    `;
    expect(source.status).toBe("failed");
    expect(source.failure_reason).toBeNull();
  });

  it("serializes concurrent idempotent replacement creates at the family budget limit", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Concurrent recovery goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Concurrent budget source', 'Original work', 'failed')
      RETURNING id
    `;
    for (let i = 1; i <= 2; i += 1) {
      await db`
        INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
        VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`Concurrent existing replacement ${i}`}, 'Recovery work', 'failed', ${sourceTask.id})
      `;
    }

    const attempts = await Promise.all([1, 2, 3].map(async (attempt) => {
      const res = await createTask(taskCreateRequest({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: `${TEST_PREFIX}Concurrent replacement task ${attempt}`,
        brief: "Only one concurrent replacement should fit the family budget",
        goalId: goal.id,
        sourceTaskId: sourceTask.id,
        createdBy: "goal-supervisor",
      }, { "Idempotency-Key": `tasks-concurrent-${attempt}` }));
      return { status: res.status, body: await res.json() };
    }));

    expect(attempts.filter((attempt) => attempt.status === 201)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 409)).toHaveLength(2);
    for (const blocked of attempts.filter((attempt) => attempt.status === 409)) {
      expect(blocked.body.error).toContain("Recovery budget exhausted");
    }

    const replacements = await db`
      SELECT id FROM tasks WHERE parent_task_id = ${sourceTask.id}
    `;
    expect(replacements).toHaveLength(3);
  });

  it("serializes concurrent non-idempotent replacement creates at the family budget limit", async () => {
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Concurrent no-key recovery goal', 'active')
      RETURNING id
    `;
    const [sourceTask] = await db`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
      VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', 'Concurrent no-key budget source', 'Original work', 'failed')
      RETURNING id
    `;
    for (let i = 1; i <= 2; i += 1) {
      await db`
        INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
        VALUES (${testHiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`Concurrent no-key existing replacement ${i}`}, 'Recovery work', 'failed', ${sourceTask.id})
      `;
    }

    const attempts = await Promise.all([1, 2, 3].map(async (attempt) => {
      const res = await createTask(taskCreateRequest({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: `${TEST_PREFIX}Concurrent no-key replacement task ${attempt}`,
        brief: "Only one concurrent replacement should fit the family budget",
        goalId: goal.id,
        sourceTaskId: sourceTask.id,
        createdBy: "goal-supervisor",
      }));
      return { status: res.status, body: await res.json() };
    }));

    expect(attempts.filter((attempt) => attempt.status === 201)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 409)).toHaveLength(2);
    for (const blocked of attempts.filter((attempt) => attempt.status === 409)) {
      expect(blocked.body.error).toContain("Recovery budget exhausted");
    }

    const replacements = await db`
      SELECT id FROM tasks WHERE parent_task_id = ${sourceTask.id}
    `;
    expect(replacements).toHaveLength(3);
  });

  it("leaves projectId null when projectId is omitted with one project", async () => {
    await db`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${testHiveId}, 'only-project', 'Only Project', '/tmp/only-project')
    `;

    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: TEST_PREFIX + "Project default",
        brief: "Task without an explicit project id",
        createdBy: "test-runner",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.projectId).toBeNull();
  });

  it("inherits the goal project when projectId is omitted", async () => {
    const [project] = await db`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${testHiveId}, 'goal-project', 'Goal Project', '/tmp/goal-project')
      RETURNING id
    `;
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, project_id)
      VALUES (${testHiveId}, 'Project-bound goal', ${project.id})
      RETURNING id
    `;

    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: TEST_PREFIX + "Goal project task",
        brief: "Task inherits project from the goal",
        goalId: goal.id,
        createdBy: "test-runner",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.projectId).toBe(project.id);
  });

  it("leaves projectId null when the hive has no projects", async () => {
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: TEST_PREFIX + "Operations task",
        brief: "Task for an operations-only hive",
        createdBy: "test-runner",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.projectId).toBeNull();
  });

  it("leaves projectId null when projectId is omitted for a multi-project hive", async () => {
    await db`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES
        (${testHiveId}, 'project-a', 'Project A', '/tmp/project-a'),
        (${testHiveId}, 'project-b', 'Project B', '/tmp/project-b')
    `;

    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "dev-agent",
        title: TEST_PREFIX + "Ambiguous project",
        brief: "Task without project id in multi-project hive",
        createdBy: "test-runner",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.projectId).toBeNull();
  });

  it("rejects content execution tasks from goal supervisors when the content pipeline fits", async () => {
    await db`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, active)
      VALUES ('global', null, 'content-publishing', 'Content Publishing', 'marketing', true)
    `;
    const [goal] = await db`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${testHiveId}, 'Facebook ad goal', 'active')
      RETURNING id
    `;

    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        assignedTo: "content-writer",
        title: TEST_PREFIX + "Draft Facebook ad",
        brief: "Create Facebook ad copy and campaign creative directly.",
        goalId: goal.id,
        createdBy: "goal-supervisor",
      }),
    });

    const res = await createTask(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("content-publishing");

    const created = await db`
      SELECT id FROM tasks WHERE title = ${TEST_PREFIX + "Draft Facebook ad"}
    `;
    expect(created).toHaveLength(0);
  });

  it("returns 400 for missing required fields", async () => {
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        // missing assignedTo, title, brief
      }),
    });
    const res = await createTask(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing required fields/i);
  });
});

describe("GET /api/tasks", () => {
  it("returns paginated task list filtered by hiveId", async () => {
    const req = new Request(
      `http://localhost:3000/api/tasks?hiveId=${testHiveId}&limit=10&offset=0`,
    );
    const res = await getTasks(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    const found = body.data.find((t: { id: string }) => t.id === testTaskId);
    expect(found).toBeDefined();
  });

  it("filters by assignedTo", async () => {
    const req = new Request(
      `http://localhost:3000/api/tasks?hiveId=${testHiveId}&assignedTo=dev-agent`,
    );
    const res = await getTasks(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.every((t: { assignedTo: string }) => t.assignedTo === "dev-agent")).toBe(true);
  });
});

describe("GET /api/tasks/[id]", () => {
  it("returns task detail by id", async () => {
    const req = new Request(`http://localhost:3000/api/tasks/${testTaskId}?hiveId=${testHiveId}`);
    const res = await getTaskById(req, { params: Promise.resolve({ id: testTaskId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(testTaskId);
    expect(body.data.title).toBe(TEST_PREFIX + "Build widget");
    expect(body.data.hiveId).toBe(testHiveId);
  });

  it("returns 404 for nonexistent task", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://localhost:3000/api/tasks/${fakeId}?hiveId=${testHiveId}`);
    const res = await getTaskById(req, { params: Promise.resolve({ id: fakeId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});
