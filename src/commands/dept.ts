import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { applyOrgOp, loadOrg, updateOrg, type OrgOp } from '../core/org.js'
import { resolveTarget } from '../core/resolve.js'

const USAGE = `usage: termbus dept <command>
  list [--json]                       departments and their agents
  create <name>                       e.g. termbus dept create api
  add <name> <target> [target…]       put panes in a department (moves them out of any other)
  remove <name> <target> [target…]    take panes out
  rename <name> <new-name>
  delete <name>                       the panes stay open; only the grouping goes
Targets are anything \`termbus send\` accepts (label, title, "self"…).
Message a whole department with: termbus broadcast @<name> "…"`

export async function cmdDept(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: true })
  const [sub, name, ...rest] = positionals
  if (!sub || sub === 'help') {
    console.log(USAGE)
    return
  }
  if (sub === 'list' || sub === 'ls') return list(!!values.json)

  let op: OrgOp
  switch (sub) {
    case 'create':
    case 'delete':
      if (!name) throw new TermbusError(USAGE)
      op = { op: sub, department: name }
      break
    case 'rename':
      if (!name || !rest[0]) throw new TermbusError(USAGE)
      op = { op: 'rename', department: name, newName: rest[0] }
      break
    case 'add':
    case 'remove': {
      if (!name || rest.length === 0) throw new TermbusError(USAGE)
      const panes = await detectBackend().listPanes()
      op = { op: sub, department: name, paneIds: rest.map((t) => resolveTarget(panes, t).id) }
      break
    }
    default:
      throw new TermbusError(`unknown dept command "${sub}"\n${USAGE}`)
  }
  updateOrg((org) => applyOrgOp(org, op))
  const verb = { create: 'created', delete: 'deleted', rename: 'renamed', add: 'added to', remove: 'removed from' }[op.op]
  console.log(op.op === 'add' || op.op === 'remove' ? `${op.paneIds.length} pane(s) ${verb} ${name}` : `department ${name} ${verb}`)
}

async function list(json: boolean): Promise<void> {
  const org = loadOrg()
  const panes = await detectBackend().listPanes()
  const rows = await Promise.all(
    org.departments.map(async (d) => ({
      name: d.name,
      members: await Promise.all(
        d.members.map(async (id) => {
          const p = panes.find((x) => x.id === id)
          return p
            ? { paneId: id, open: true, label: p.label, title: p.title, occupant: (await occupantForTty(p.tty)).kind }
            : { paneId: id, open: false }
        }),
      ),
    })),
  )
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('no departments yet — termbus dept create <name>')
    return
  }
  for (const d of rows) {
    console.log(`@${d.name}  (${d.members.filter((m) => m.open).length} open)`)
    for (const m of d.members) {
      console.log(m.open ? `  ${m.label!.padEnd(10)} ${String(m.occupant).padEnd(8)} ${m.title}` : `  (not open)  ${m.paneId}`)
    }
  }
}
