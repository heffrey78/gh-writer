import { buildSchema, graphql, GraphQLError } from "graphql";

/*
 * GitHub Projects (v2) for the fake GitHub: the part of GitHub's GraphQL schema the drafting board
 * uses (#11), with the same type, field and argument names, run by graphql-js. A query that GitHub's
 * schema wouldn't accept fails here too. Where GitHub's behaviour is unsure, the fake does the less
 * convenient thing: changing a single-select field's options gives them new IDs and clears the
 * values that used them.
 */

export interface FakeOption {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface FakeField {
  id: string;
  name: string;
  /** TITLE, ASSIGNEES, LABELS, REPOSITORY and MILESTONE are GitHub's own; TEXT, NUMBER, DATE and SINGLE_SELECT can be made. */
  dataType: string;
  options?: FakeOption[];
}

export interface FakeItem {
  id: string;
  type: "DRAFT_ISSUE" | "ISSUE";
  content: { id: string; title: string; body: string };
  /** field ID → text, number, date, or a single-select option's ID. */
  values: Record<string, string | number>;
  isArchived: boolean;
  updatedAt: string;
}

export interface FakeProject {
  id: string;
  number: number;
  /** The login of the account that owns it. */
  owner: string;
  title: string;
  readme: string | null;
  shortDescription: string | null;
  closed: boolean;
  public: boolean;
  /** owner/name of each repository it's linked to. */
  repositories: string[];
  fields: FakeField[];
  items: FakeItem[];
}

export interface FakeProjects {
  all: FakeProject[];
  /** Answer a GraphQL request as `login` with `scopes`. */
  execute(body: string, login: string, scopes: string[], repoExists: (owner: string, name: string) => boolean): Promise<unknown>;
  /** A field's value on an item, as the board shows it: an option's name, text or number; null when empty. */
  value(project: FakeProject, item: FakeItem, field: string): string | number | null;
  /** Set a field as if on github.com (an option by its name; null clears it). */
  set(project: FakeProject, item: FakeItem, field: string, value: string | number | null): void;
  /** The item whose `field` holds `value`. */
  find(project: FakeProject, field: string, value: string | number): FakeItem | undefined;
  /** Delete a project as if on github.com. */
  remove(project: FakeProject): void;
  /** Requests answered, each the operation's mutations or top-level query fields. */
  operations: string[][];
  /** Refuse changes to a project's own Status field, as GitHub might. */
  lockStatus: boolean;
}

const SDL = /* GraphQL */ `
  scalar URI
  scalar DateTime
  scalar Date

  interface Node {
    id: ID!
  }

  interface RepositoryOwner {
    id: ID!
    login: String!
  }

  type User implements Node & RepositoryOwner {
    id: ID!
    login: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Repository implements Node {
    id: ID!
    name: String!
    owner: RepositoryOwner!
    projectsV2(first: Int, after: String, query: String): ProjectV2Connection!
  }

  type ProjectV2Connection {
    nodes: [ProjectV2]
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ProjectV2 implements Node {
    id: ID!
    number: Int!
    title: String!
    url: URI!
    closed: Boolean!
    public: Boolean!
    readme: String
    shortDescription: String
    fields(first: Int, after: String): ProjectV2FieldConfigurationConnection!
    items(first: Int, after: String): ProjectV2ItemConnection!
  }

  enum ProjectV2FieldType {
    ASSIGNEES
    DATE
    ITERATION
    LABELS
    LINKED_PULL_REQUESTS
    MILESTONE
    NUMBER
    REPOSITORY
    REVIEWERS
    SINGLE_SELECT
    TEXT
    TITLE
    TRACKS
  }

  enum ProjectV2CustomFieldType {
    DATE
    ITERATION
    NUMBER
    SINGLE_SELECT
    TEXT
  }

  enum ProjectV2SingleSelectFieldOptionColor {
    BLUE
    GRAY
    GREEN
    ORANGE
    PINK
    PURPLE
    RED
    YELLOW
  }

  interface ProjectV2FieldCommon {
    id: ID!
    name: String!
    dataType: ProjectV2FieldType!
  }

  type ProjectV2Field implements Node & ProjectV2FieldCommon {
    id: ID!
    name: String!
    dataType: ProjectV2FieldType!
  }

  type ProjectV2SingleSelectFieldOption {
    id: String!
    name: String!
    color: ProjectV2SingleSelectFieldOptionColor!
    description: String!
  }

  type ProjectV2SingleSelectField implements Node & ProjectV2FieldCommon {
    id: ID!
    name: String!
    dataType: ProjectV2FieldType!
    options(names: [String!]): [ProjectV2SingleSelectFieldOption!]!
  }

  type ProjectV2IterationField implements Node & ProjectV2FieldCommon {
    id: ID!
    name: String!
    dataType: ProjectV2FieldType!
  }

  union ProjectV2FieldConfiguration = ProjectV2Field | ProjectV2IterationField | ProjectV2SingleSelectField

  type ProjectV2FieldConfigurationConnection {
    nodes: [ProjectV2FieldConfiguration]
    pageInfo: PageInfo!
    totalCount: Int!
  }

  enum ProjectV2ItemType {
    DRAFT_ISSUE
    ISSUE
    PULL_REQUEST
    REDACTED
  }

  type DraftIssue implements Node {
    id: ID!
    title: String!
    body: String!
  }

  type Issue implements Node {
    id: ID!
    number: Int!
    title: String!
  }

  union ProjectV2ItemContent = DraftIssue | Issue

  type ProjectV2Item implements Node {
    id: ID!
    type: ProjectV2ItemType!
    isArchived: Boolean!
    updatedAt: DateTime!
    content: ProjectV2ItemContent
    fieldValues(first: Int, after: String): ProjectV2ItemFieldValueConnection!
  }

  type ProjectV2ItemConnection {
    nodes: [ProjectV2Item]
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ProjectV2ItemFieldTextValue {
    text: String
    field: ProjectV2FieldConfiguration!
  }

  type ProjectV2ItemFieldNumberValue {
    number: Float
    field: ProjectV2FieldConfiguration!
  }

  type ProjectV2ItemFieldDateValue {
    date: Date
    field: ProjectV2FieldConfiguration!
  }

  type ProjectV2ItemFieldSingleSelectValue {
    name: String
    optionId: String
    field: ProjectV2FieldConfiguration!
  }

  union ProjectV2ItemFieldValue = ProjectV2ItemFieldDateValue | ProjectV2ItemFieldNumberValue | ProjectV2ItemFieldSingleSelectValue | ProjectV2ItemFieldTextValue

  type ProjectV2ItemFieldValueConnection {
    nodes: [ProjectV2ItemFieldValue]
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Query {
    repository(owner: String!, name: String!): Repository
    node(id: ID!): Node
    viewer: User!
  }

  input CreateProjectV2Input {
    ownerId: ID!
    title: String!
    repositoryId: ID
    clientMutationId: String
  }
  type CreateProjectV2Payload {
    projectV2: ProjectV2
  }

  input UpdateProjectV2Input {
    projectId: ID!
    title: String
    shortDescription: String
    readme: String
    public: Boolean
    closed: Boolean
    clientMutationId: String
  }
  type UpdateProjectV2Payload {
    projectV2: ProjectV2
  }

  input LinkProjectV2ToRepositoryInput {
    projectId: ID!
    repositoryId: ID!
    clientMutationId: String
  }
  type LinkProjectV2ToRepositoryPayload {
    repository: Repository
  }

  input ProjectV2SingleSelectFieldOptionInput {
    name: String!
    color: ProjectV2SingleSelectFieldOptionColor!
    description: String!
  }

  input CreateProjectV2FieldInput {
    projectId: ID!
    dataType: ProjectV2CustomFieldType!
    name: String!
    singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]
    clientMutationId: String
  }
  type CreateProjectV2FieldPayload {
    projectV2Field: ProjectV2FieldConfiguration
  }

  input UpdateProjectV2FieldInput {
    fieldId: ID!
    name: String
    singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]
    clientMutationId: String
  }
  type UpdateProjectV2FieldPayload {
    projectV2Field: ProjectV2FieldConfiguration
  }

  input AddProjectV2DraftIssueInput {
    projectId: ID!
    title: String!
    body: String
    clientMutationId: String
  }
  type AddProjectV2DraftIssuePayload {
    projectItem: ProjectV2Item
  }

  input UpdateProjectV2DraftIssueInput {
    draftIssueId: ID!
    title: String
    body: String
    clientMutationId: String
  }
  type UpdateProjectV2DraftIssuePayload {
    draftIssue: DraftIssue
  }

  input ProjectV2FieldValue {
    text: String
    number: Float
    date: Date
    singleSelectOptionId: String
    iterationId: String
  }

  input UpdateProjectV2ItemFieldValueInput {
    projectId: ID!
    itemId: ID!
    fieldId: ID!
    value: ProjectV2FieldValue!
    clientMutationId: String
  }
  type UpdateProjectV2ItemFieldValuePayload {
    projectV2Item: ProjectV2Item
  }

  input ClearProjectV2ItemFieldValueInput {
    projectId: ID!
    itemId: ID!
    fieldId: ID!
    clientMutationId: String
  }
  type ClearProjectV2ItemFieldValuePayload {
    projectV2Item: ProjectV2Item
  }

  input DeleteProjectV2ItemInput {
    projectId: ID!
    itemId: ID!
    clientMutationId: String
  }
  type DeleteProjectV2ItemPayload {
    deletedItemId: ID
  }

  type Mutation {
    createProjectV2(input: CreateProjectV2Input!): CreateProjectV2Payload
    updateProjectV2(input: UpdateProjectV2Input!): UpdateProjectV2Payload
    linkProjectV2ToRepository(input: LinkProjectV2ToRepositoryInput!): LinkProjectV2ToRepositoryPayload
    createProjectV2Field(input: CreateProjectV2FieldInput!): CreateProjectV2FieldPayload
    updateProjectV2Field(input: UpdateProjectV2FieldInput!): UpdateProjectV2FieldPayload
    addProjectV2DraftIssue(input: AddProjectV2DraftIssueInput!): AddProjectV2DraftIssuePayload
    updateProjectV2DraftIssue(input: UpdateProjectV2DraftIssueInput!): UpdateProjectV2DraftIssuePayload
    updateProjectV2ItemFieldValue(input: UpdateProjectV2ItemFieldValueInput!): UpdateProjectV2ItemFieldValuePayload
    clearProjectV2ItemFieldValue(input: ClearProjectV2ItemFieldValueInput!): ClearProjectV2ItemFieldValuePayload
    deleteProjectV2Item(input: DeleteProjectV2ItemInput!): DeleteProjectV2ItemPayload
  }
`;

const schema = buildSchema(SDL);

/** An error as GitHub sends it: with a `type` beside the message. */
class TypedError extends GraphQLError {
  constructor(type: string, message: string) {
    super(message, { extensions: { type } });
  }
}

/** A page of `items` from `after` (the index after the last one handed out), at most `first` (GitHub caps it at 100). */
function connection<T>(items: T[], first = 100, after?: string) {
  if (first > 100) throw new TypedError("EXCESSIVE_PAGE_SIZE", "Requesting more than 100 records on a connection is not allowed.");
  const start = after ? Number(after) : 0;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, totalCount: items.length, pageInfo: { hasNextPage: end < items.length, endCursor: nodes.length ? String(end) : null } };
}

export function fakeProjects({ webUrl, now }: { webUrl: () => string; now: () => string }): FakeProjects {
  let ids = 0;
  const id = (prefix: string) => `${prefix}_${(++ids).toString(36).padStart(6, "0")}`;
  const all: FakeProject[] = [];
  const operations: string[][] = [];

  const fieldJson = (f: FakeField) =>
    f.dataType === "SINGLE_SELECT"
      ? { __typename: "ProjectV2SingleSelectField", id: f.id, name: f.name, dataType: f.dataType, options: ({ names }: { names?: string[] }) => (f.options ?? []).filter((o) => !names || names.includes(o.name)) }
      : { __typename: f.dataType === "ITERATION" ? "ProjectV2IterationField" : "ProjectV2Field", id: f.id, name: f.name, dataType: f.dataType };

  const valueOf = (i: FakeItem, f: FakeField) => {
    if (f.dataType === "TITLE") return { __typename: "ProjectV2ItemFieldTextValue", text: i.content.title, field: fieldJson(f) };
    const v = i.values[f.id];
    if (v === undefined) return undefined;
    if (f.dataType === "SINGLE_SELECT") {
      const option = f.options?.find((o) => o.id === v);
      return option && { __typename: "ProjectV2ItemFieldSingleSelectValue", name: option.name, optionId: option.id, field: fieldJson(f) };
    }
    if (f.dataType === "NUMBER") return { __typename: "ProjectV2ItemFieldNumberValue", number: v, field: fieldJson(f) };
    if (f.dataType === "DATE") return { __typename: "ProjectV2ItemFieldDateValue", date: v, field: fieldJson(f) };
    return { __typename: "ProjectV2ItemFieldTextValue", text: v, field: fieldJson(f) };
  };

  const itemJson = (p: FakeProject, i: FakeItem) => ({
    __typename: "ProjectV2Item",
    id: i.id,
    type: i.type,
    isArchived: i.isArchived,
    updatedAt: i.updatedAt,
    content: { __typename: i.type === "DRAFT_ISSUE" ? "DraftIssue" : "Issue", ...i.content, number: 1 },
    fieldValues: ({ first, after }: { first?: number; after?: string }) => connection(p.fields.map((f) => valueOf(i, f)).filter(Boolean), first, after),
  });

  const projectJson = (p: FakeProject) => ({
    __typename: "ProjectV2",
    id: p.id,
    number: p.number,
    title: p.title,
    url: `${webUrl()}/users/${p.owner}/projects/${p.number}`,
    closed: p.closed,
    public: p.public,
    readme: p.readme,
    shortDescription: p.shortDescription,
    fields: ({ first, after }: { first?: number; after?: string }) => connection(p.fields.map(fieldJson), first, after),
    items: ({ first, after }: { first?: number; after?: string }) => connection(p.items.map((i) => itemJson(p, i)), first, after),
  });

  const userJson = (login: string) => ({ __typename: "User", id: `U_${login}`, login });

  const notFound = (what: string) => new TypedError("NOT_FOUND", `Could not resolve to a node with the global id of '${what}'.`);

  const execute: FakeProjects["execute"] = async (body, login, scopes, repoExists) => {
    const { query, variables } = JSON.parse(body || "{}") as { query?: string; variables?: Record<string, unknown> };
    const canRead = scopes.includes("project") || scopes.includes("read:project");
    const canWrite = scopes.includes("project");
    const needs = (write: boolean) => {
      if (!(write ? canWrite : canRead)) throw new TypedError("INSUFFICIENT_SCOPES", `Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['${write ? "project" : "read:project"}'].`);
    };
    const mine = (projectId: string) => {
      const p = all.find((x) => x.id === projectId);
      if (!p || p.owner !== login) throw notFound(projectId);
      return p;
    };
    const itemOf = (p: FakeProject, itemId: string) => {
      const i = p.items.find((x) => x.id === itemId);
      if (!i) throw notFound(itemId);
      return i;
    };
    const fieldOf = (p: FakeProject, fieldId: string) => {
      const f = p.fields.find((x) => x.id === fieldId);
      if (!f) throw notFound(fieldId);
      return f;
    };
    const repoJson = (owner: string, name: string) => ({
      __typename: "Repository",
      id: `R_${owner}/${name}`,
      name,
      owner: userJson(owner),
      projectsV2: ({ first, after }: { first?: number; after?: string }) => {
        needs(false);
        return connection(all.filter((p) => p.repositories.includes(`${owner}/${name}`)).map(projectJson), first, after);
      },
    });
    const repoOfId = (repositoryId: string) => {
      const m = /^R_([^/]+)\/(.+)$/.exec(repositoryId);
      if (!m || m[1] !== login || !repoExists(m[1], m[2]!)) throw notFound(repositoryId);
      return `${m[1]}/${m[2]}`;
    };
    const options = (input: { name: string; color: string; description: string }[] | undefined) => (input ?? []).map((o) => ({ id: id("opt").slice(4), name: o.name, color: o.color, description: o.description }));
    const touch = (i: FakeItem) => (i.updatedAt = now());

    const rootValue = {
      viewer: () => userJson(login),
      repository: ({ owner, name }: { owner: string; name: string }) => (owner === login && repoExists(owner, name) ? repoJson(owner, name) : null),
      node: ({ id: nodeId }: { id: string }) => {
        const p = all.find((x) => x.id === nodeId);
        if (p) {
          needs(false);
          return p.owner === login ? projectJson(p) : null;
        }
        return null;
      },
      createProjectV2: ({ input }: { input: { ownerId: string; title: string; repositoryId?: string } }) => {
        needs(true);
        if (input.ownerId !== `U_${login}`) throw notFound(input.ownerId);
        const repo = input.repositoryId ? repoOfId(input.repositoryId) : undefined;
        const p: FakeProject = {
          id: id("PVT"),
          number: all.filter((x) => x.owner === login).reduce((n, x) => Math.max(n, x.number), 0) + 1,
          owner: login,
          title: input.title,
          readme: null,
          shortDescription: null,
          closed: false,
          public: false,
          repositories: repo ? [repo] : [],
          // A new project's own fields, as GitHub makes them.
          fields: [
            { id: id("PVTF"), name: "Title", dataType: "TITLE" },
            { id: id("PVTF"), name: "Assignees", dataType: "ASSIGNEES" },
            {
              id: id("PVTSSF"),
              name: "Status",
              dataType: "SINGLE_SELECT",
              options: options([
                { name: "Todo", color: "GREEN", description: "This item hasn't been started" },
                { name: "In Progress", color: "YELLOW", description: "This is actively being worked on" },
                { name: "Done", color: "PURPLE", description: "This has been completed" },
              ]),
            },
            { id: id("PVTF"), name: "Labels", dataType: "LABELS" },
            { id: id("PVTF"), name: "Repository", dataType: "REPOSITORY" },
            { id: id("PVTF"), name: "Milestone", dataType: "MILESTONE" },
          ],
          items: [],
        };
        all.push(p);
        return { projectV2: projectJson(p) };
      },
      updateProjectV2: ({ input }: { input: { projectId: string; title?: string; shortDescription?: string; readme?: string; public?: boolean; closed?: boolean } }) => {
        needs(true);
        const p = mine(input.projectId);
        if (input.title !== undefined) p.title = input.title;
        if (input.shortDescription !== undefined) p.shortDescription = input.shortDescription;
        if (input.readme !== undefined) p.readme = input.readme;
        if (input.public !== undefined) p.public = input.public;
        if (input.closed !== undefined) p.closed = input.closed;
        return { projectV2: projectJson(p) };
      },
      linkProjectV2ToRepository: ({ input }: { input: { projectId: string; repositoryId: string } }) => {
        needs(true);
        const p = mine(input.projectId);
        const repo = repoOfId(input.repositoryId);
        if (!p.repositories.includes(repo)) p.repositories.push(repo);
        const [owner, name] = repo.split("/") as [string, string];
        return { repository: repoJson(owner, name) };
      },
      createProjectV2Field: ({ input }: { input: { projectId: string; dataType: string; name: string; singleSelectOptions?: FakeOption[] } }) => {
        needs(true);
        const p = mine(input.projectId);
        if (p.fields.some((f) => f.name.toLowerCase() === input.name.toLowerCase())) throw new TypedError("UNPROCESSABLE", "Name has already been taken");
        if (input.dataType === "SINGLE_SELECT" && !input.singleSelectOptions?.length) throw new TypedError("UNPROCESSABLE", "Single select fields must have at least one option");
        const f: FakeField = { id: id(input.dataType === "SINGLE_SELECT" ? "PVTSSF" : "PVTF"), name: input.name, dataType: input.dataType, ...(input.dataType === "SINGLE_SELECT" ? { options: options(input.singleSelectOptions) } : {}) };
        p.fields.push(f);
        return { projectV2Field: fieldJson(f) };
      },
      updateProjectV2Field: ({ input }: { input: { fieldId: string; name?: string; singleSelectOptions?: FakeOption[] } }) => {
        needs(true);
        const p = all.find((x) => x.owner === login && x.fields.some((f) => f.id === input.fieldId));
        if (!p) throw notFound(input.fieldId);
        const f = fieldOf(p, input.fieldId);
        if (self.lockStatus && f.name === "Status") throw new TypedError("UNPROCESSABLE", "The Status field can't be changed");
        if (input.name !== undefined) f.name = input.name;
        if (input.singleSelectOptions) {
          if (f.dataType !== "SINGLE_SELECT") throw new TypedError("UNPROCESSABLE", "Only single select fields have options");
          // New IDs for every option; values that used the old ones are cleared.
          f.options = options(input.singleSelectOptions);
          for (const i of p.items) {
            if (i.values[f.id] !== undefined) {
              delete i.values[f.id];
              touch(i);
            }
          }
        }
        return { projectV2Field: fieldJson(f) };
      },
      addProjectV2DraftIssue: ({ input }: { input: { projectId: string; title: string; body?: string } }) => {
        needs(true);
        const p = mine(input.projectId);
        if (!input.title.trim()) throw new TypedError("UNPROCESSABLE", "Title can't be blank");
        const i: FakeItem = { id: id("PVTI"), type: "DRAFT_ISSUE", content: { id: id("DI"), title: input.title, body: input.body ?? "" }, values: {}, isArchived: false, updatedAt: now() };
        p.items.push(i);
        return { projectItem: itemJson(p, i) };
      },
      updateProjectV2DraftIssue: ({ input }: { input: { draftIssueId: string; title?: string; body?: string } }) => {
        needs(true);
        for (const p of all.filter((x) => x.owner === login)) {
          const i = p.items.find((x) => x.content.id === input.draftIssueId);
          if (!i) continue;
          if (input.title !== undefined) i.content.title = input.title;
          if (input.body !== undefined) i.content.body = input.body;
          touch(i);
          return { draftIssue: { __typename: "DraftIssue", ...i.content } };
        }
        throw notFound(input.draftIssueId);
      },
      updateProjectV2ItemFieldValue: ({ input }: { input: { projectId: string; itemId: string; fieldId: string; value: { text?: string; number?: number; date?: string; singleSelectOptionId?: string } } }) => {
        needs(true);
        const p = mine(input.projectId);
        const i = itemOf(p, input.itemId);
        const f = fieldOf(p, input.fieldId);
        const v = input.value;
        if (f.dataType === "TITLE") {
          if (v.text === undefined) throw new TypedError("UNPROCESSABLE", "A title needs text");
          i.content.title = v.text;
        } else if (f.dataType === "SINGLE_SELECT") {
          if (!f.options?.some((o) => o.id === v.singleSelectOptionId)) throw new TypedError("UNPROCESSABLE", "The single select option Id does not belong to the field");
          i.values[f.id] = v.singleSelectOptionId!;
        } else if (f.dataType === "NUMBER" && typeof v.number === "number") i.values[f.id] = v.number;
        else if (f.dataType === "TEXT" && typeof v.text === "string") i.values[f.id] = v.text;
        else if (f.dataType === "DATE" && typeof v.date === "string") i.values[f.id] = v.date;
        else throw new TypedError("UNPROCESSABLE", `The value doesn't fit a ${f.dataType} field`);
        touch(i);
        return { projectV2Item: itemJson(p, i) };
      },
      clearProjectV2ItemFieldValue: ({ input }: { input: { projectId: string; itemId: string; fieldId: string } }) => {
        needs(true);
        const p = mine(input.projectId);
        const i = itemOf(p, input.itemId);
        fieldOf(p, input.fieldId);
        delete i.values[input.fieldId];
        touch(i);
        return { projectV2Item: itemJson(p, i) };
      },
      deleteProjectV2Item: ({ input }: { input: { projectId: string; itemId: string } }) => {
        needs(true);
        const p = mine(input.projectId);
        itemOf(p, input.itemId);
        p.items = p.items.filter((x) => x.id !== input.itemId);
        return { deletedItemId: input.itemId };
      },
    };

    operations.push(topFields(query ?? ""));
    const result = await graphql({ schema, source: query ?? "", rootValue, ...(variables ? { variableValues: variables } : {}) });
    return {
      ...(result.data !== undefined ? { data: result.data } : {}),
      // GitHub puts the error's type beside its message.
      ...(result.errors ? { errors: result.errors.map((e) => ({ message: e.message, ...(e.path ? { path: e.path } : {}), ...(e.extensions?.type ? { type: e.extensions.type } : {}) })) } : {}),
    };
  };

  const field = (p: FakeProject, name: string) => {
    const f = p.fields.find((x) => x.name === name);
    if (!f) throw new Error(`No field ${name} on project ${p.number}`);
    return f;
  };

  const self: FakeProjects = {
    all,
    operations,
    lockStatus: false,
    execute,
    value: (p, i, name) => {
      const f = field(p, name);
      if (f.dataType === "TITLE") return i.content.title;
      const v = i.values[f.id];
      if (v === undefined) return null;
      return f.dataType === "SINGLE_SELECT" ? (f.options?.find((o) => o.id === v)?.name ?? null) : v;
    },
    set: (p, i, name, value) => {
      const f = field(p, name);
      if (value === null) delete i.values[f.id];
      else if (f.dataType === "TITLE") i.content.title = String(value);
      else if (f.dataType === "SINGLE_SELECT") {
        const option = f.options?.find((o) => o.name === value);
        if (!option) throw new Error(`No option ${value} in ${name}`);
        i.values[f.id] = option.id;
      } else i.values[f.id] = value;
      i.updatedAt = now();
    },
    find: (p, name, value) => {
      const f = field(p, name);
      return p.items.find((i) => i.values[f.id] === value);
    },
    remove: (p) => {
      const at = all.indexOf(p);
      if (at >= 0) all.splice(at, 1);
    },
  };
  return self;
}

/** The top-level fields of a request (its mutations, or what it queries), for tests that count requests. */
function topFields(query: string): string[] {
  // Arguments out of the way first: their input objects have braces of their own.
  let body = query.slice(query.indexOf("{") + 1);
  for (let before = ""; before !== body; ) [before, body] = [body, body.replace(/\([^()]*\)/g, "")];
  const out: string[] = [];
  let depth = 0;
  for (const m of body.matchAll(/[{}]|(?:(\w+)\s*:\s*)?(\w+)/g)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth--;
    else if (depth === 0 && m[2]) out.push(m[2]);
  }
  return out;
}
