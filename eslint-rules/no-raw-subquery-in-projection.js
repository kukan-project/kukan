/**
 * A correlated subquery, spelled out, inside a select projection.
 *
 * Drizzle drops the table qualifier from a bare column placed directly in a
 * projection when the FROM names a single table, so
 * `WHERE rv.resource_id = ${resource.id}` is emitted as
 * `WHERE rv.resource_id = "id"`. Inside the subquery that name resolves to the
 * subquery's own row, and the condition answers false — or zero — for every
 * row, raising nothing. Type checks pass. Row-count assertions pass whenever
 * the expected count is zero.
 *
 * `exists()` and `db.$count()` put the correlation in a WHERE, which drizzle
 * qualifies whatever the FROM looks like. This has caught the codebase three
 * times; the fourth is what the rule is for.
 *
 * Only the field's own template is examined, never anything nested inside it,
 * and that is the line drizzle itself draws: the rewrite maps over the field
 * SQL's top-level chunks and replaces the ones that *are* columns. A column
 * reached through any child — another `sql` template, a builder in a `.where()`,
 * a subquery — is not a top-level chunk and survives. Measured:
 *
 *   sql`EXISTS (SELECT 1 FROM rv WHERE rv.resource_id = ${resource.id})`
 *     -> rv.resource_id = "id"                  (stripped, wrong)
 *   sql`EXISTS (${sql`... rv.resource_id = ${resource.id}`})`
 *     -> rv.resource_id = "resource"."id"       (one level of nesting is enough)
 *
 * So a template that only interpolates a builder is left alone — that is the
 * form being asked for — as is a raw fragment passed to that builder's
 * `.where()`, and a column that was itself wrapped in a `sql` template. What is
 * read is the top-level interpolations: a nested template lands as an SQL chunk
 * and a literal as a parameter, neither of which is rewritten, while anything
 * else is taken for a column, since a name says nothing about what it holds.
 *
 * Any `.select({...})` counts, not only one on a drizzle handle: telling them
 * apart needs type information, and a `sql` tagged template in the projection
 * of something that is not a query builder is not a thing that happens here.
 *
 * Upstream: drizzle-team/drizzle-orm#5734, open. The fix in #5795 keys on
 * `usedTables`, which records only tables that were *interpolated* — so it
 * repairs `FROM ${resourceVersion} rv` and leaves `FROM resource_version rv`
 * stripped, though the two correlate identically. Landing it would not retire
 * this rule.
 */
export const noRawSubqueryInProjection = {
  meta: {
    type: 'problem',
    docs: { description: 'Correlate subqueries through drizzle, not raw SQL, in a projection' },
    schema: [],
    messages: {
      raw:
        'Raw SELECT inside a .select() projection: drizzle drops the table qualifier here and the ' +
        'correlation fails silently. Use exists() or db.$count() (see CLAUDE.md).',
    },
  },
  create(context) {
    /**
     * Wrappers that are gone by the time drizzle sees the value, so a template
     * inside one is still the template drizzle builds from. Enumerated rather
     * than matched on a `TS` prefix: each one missing from here is a way to
     * write the broken query and have the rule pass.
     */
    const ERASED = new Set([
      'TSAsExpression', // x as T
      'TSSatisfiesExpression', // x satisfies T
      'TSTypeAssertion', // <T>x
      'TSNonNullExpression', // x!
      'TSInstantiationExpression', // f<T>
    ])

    /**
     * The template that becomes the field's own SQL, seen past what wraps it
     * without nesting it — a type-only wrapper, or a chained `.as('x')` /
     * `.mapWith(Number)`. Anything else is not this field's template.
     */
    function fieldTemplate(node) {
      let current = node
      for (;;) {
        if (ERASED.has(current.type)) {
          current = current.expression
        } else if (
          current.type === 'CallExpression' &&
          current.callee.type === 'MemberExpression'
        ) {
          current = current.callee.object
        } else {
          return current
        }
      }
    }

    /**
     * Whether an interpolation could arrive as a column chunk, which is the only
     * kind drizzle rewrites. A nested `sql` template lands as an SQL chunk and a
     * literal as a parameter, and neither is touched — anything else is read as
     * a column, since a name says nothing about what it holds.
     */
    function couldBeColumn(node) {
      let current = node
      while (ERASED.has(current.type)) current = current.expression
      if (current.type === 'Literal' || current.type === 'TemplateLiteral') return false
      return !(
        current.type === 'TaggedTemplateExpression' &&
        current.tag.type === 'Identifier' &&
        current.tag.name === 'sql'
      )
    }

    /** Both arms of a choice are the field's template, on their own runs. */
    function fieldTemplates(node, found) {
      const head = fieldTemplate(node)
      if (head.type === 'ConditionalExpression') {
        fieldTemplates(head.consequent, found)
        fieldTemplates(head.alternate, found)
      } else {
        found.push(head)
      }
      return found
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'select'
        ) {
          return
        }
        const [projection] = node.arguments
        if (!projection || projection.type !== 'ObjectExpression') return
        for (const property of projection.properties) {
          if (property.type !== 'Property') continue
          for (const head of fieldTemplates(property.value, [])) {
            if (
              head.type === 'TaggedTemplateExpression' &&
              head.tag.type === 'Identifier' &&
              head.tag.name === 'sql' &&
              head.quasi.expressions.some(couldBeColumn) &&
              head.quasi.quasis.some((q) => /\bselect\b/i.test(q.value.raw))
            ) {
              context.report({ node: head, messageId: 'raw' })
            }
          }
        }
      },
    }
  },
}
