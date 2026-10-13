import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHub, memoryStore } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";

/* The fake GitHub's Projects: the board's tests lean on it, so it should behave as GitHub's schema says. */

let fake: FakeGitHub;
let github: GitHub;

beforeAll(async () => {
  fake = await fakeGitHub();
  fake.users.set("gho_projects", { login: "ada" });
  fake.repos.push({ owner: "ada", name: "salt-road", private: true, pushedAt: fake.now() });
  const store = memoryStore();
  await store.set("gho_projects");
  github = new GitHub({ clientId: "", webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined });
});

afterAll(() => fake.close());

describe("the fake GitHub's Projects", () => {
  it("makes a project linked to a repository, with fields, a draft item and its values", async () => {
    const repo = await github.graphql<{ repository: { id: string; owner: { id: string } } }>("query { repository(owner: \"ada\", name: \"salt-road\") { id owner { id } } }");
    const made = await github.graphql<{ createProjectV2: { projectV2: { id: string; number: number; url: string } } }>(
      "mutation($owner: ID!, $repo: ID!) { createProjectV2(input: { ownerId: $owner, title: \"The Salt Road\", repositoryId: $repo }) { projectV2 { id number url } } }",
      { owner: repo.repository.owner.id, repo: repo.repository.id },
    );
    const project = made.createProjectV2.projectV2;
    expect(project).toMatchObject({ number: 1, url: `${fake.url}/users/ada/projects/1` });

    const field = await github.graphql<{ createProjectV2Field: { projectV2Field: { id: string } } }>(
      "mutation($p: ID!) { createProjectV2Field(input: { projectId: $p, dataType: NUMBER, name: \"Words\" }) { projectV2Field { ... on ProjectV2Field { id } } } }",
      { p: project.id },
    );
    // Two mutations in one request, by alias.
    const item = await github.graphql<{ a: { projectItem: { id: string } } }>("mutation($p: ID!) { a: addProjectV2DraftIssue(input: { projectId: $p, title: \"The Bridge\" }) { projectItem { id } } }", { p: project.id });
    await github.graphql("mutation($p: ID!, $i: ID!, $f: ID!) { a0: updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { number: 812 } }) { projectV2Item { id } } a1: updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { number: 900 } }) { projectV2Item { id } } }", {
      p: project.id,
      i: item.a.projectItem.id,
      f: field.createProjectV2Field.projectV2Field.id,
    });
    expect(fake.projects.operations.at(-1)).toEqual(["updateProjectV2ItemFieldValue", "updateProjectV2ItemFieldValue"]);

    const read = await github.graphql<{ repository: { projectsV2: { nodes: { items: { nodes: { content: { title: string }; fieldValues: { nodes: ({ text?: string; number?: number; field: { name: string } } | object)[] } }[] } }[] } } }>(`query {
      repository(owner: "ada", name: "salt-road") {
        projectsV2(first: 10) {
          nodes {
            items(first: 10) {
              nodes {
                content { ... on DraftIssue { title } }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                    ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                  }
                }
              }
            }
          }
        }
      }
    }`);
    const [only] = read.repository.projectsV2.nodes[0]!.items.nodes;
    expect(only!.content.title).toBe("The Bridge");
    expect(only!.fieldValues.nodes).toEqual([
      { text: "The Bridge", field: { name: "Title" } },
      { number: 900, field: { name: "Words" } },
    ]);

    // As if moved on github.com.
    const p = fake.projects.all[0]!;
    fake.projects.set(p, p.items[0]!, "Status", "Done");
    expect(fake.projects.value(p, p.items[0]!, "Status")).toBe("Done");
  });

  it("gives a single-select field's options new IDs when they're changed, clearing values that used them", async () => {
    const p = fake.projects.all[0]!;
    const status = p.fields.find((f) => f.name === "Status")!;
    await github.graphql("mutation($f: ID!) { updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: [{ name: \"Idea\", color: GRAY, description: \"\" }, { name: \"Done\", color: PURPLE, description: \"\" }] }) { projectV2Field { ... on ProjectV2SingleSelectField { options { name } } } } }", { f: status.id });
    expect(status.options!.map((o) => o.name)).toEqual(["Idea", "Done"]);
    expect(fake.projects.value(p, p.items[0]!, "Status")).toBeNull();
  });

  it("refuses a query GitHub's schema wouldn't take", async () => {
    await expect(github.graphql("query { repository(owner: \"ada\", name: \"salt-road\") { projectsV2 { nodes { colour } } } }")).rejects.toMatchObject({ code: "GITHUB" });
  });
});
