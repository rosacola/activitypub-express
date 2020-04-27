'use strict'
const connection = require('./connection')
module.exports = {
  get,
  save,
  update
}

const proj = { _id: 0, _meta: 0 }
const metaProj = { _id: 0 }

function get (id, includeMeta) {
  return connection.getDb()
    .collection('objects')
    .find({ id: id })
    .limit(1)
    // strict comparison as we don't want to return private keys on accident
    .project(includeMeta === true ? metaProj : proj)
    .next()
}

async function save (object) {
  const db = connection.getDb()
  const exists = await db.collection('objects')
    .find({ id: object.id })
    .project({ _id: 1 })
    .limit(1)
    .hasNext()
  if (exists) {
    return false
  }
  return db.collection('objects')
    .insertOne(object, { forceServerObjectId: true })
}

function update (object, actor) {
  let doSet = false
  let doUnset = false
  const set = {}
  const unset = {}
  const op = {}
  for (const [key, value] of Object.entries(object)) {
    if (key === 'id') continue
    if (value === null) {
      doUnset = true
      unset[key] = ''
    } else {
      doSet = true
      set[key] = value
    }
  }
  if (doSet) {
    op.$set = set
  }
  if (doUnset) {
    op.$unset = unset
  }
  return connection.getDb().collection('objects')
    .findOneAndUpdate({ id: object.id, attributedTo: actor }, op, { returnOriginal: false })
}
