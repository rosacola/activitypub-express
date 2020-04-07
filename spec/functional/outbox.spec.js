/* global describe, beforeAll, beforeEach, afterEach, it, expect */
const request = require('supertest')
const express = require('express')
const nock = require('nock')
const httpSignature = require('http-signature')
const { MongoClient } = require('mongodb')
const crypto = require('crypto')
const { promisify } = require('util')
const generateKeyPairPromise = promisify(crypto.generateKeyPair)

const ActivitypubExpress = require('../../index')

const app = express()
const apex = ActivitypubExpress({
  domain: 'localhost'
})
const client = new MongoClient('mongodb://localhost:27017', { useUnifiedTopology: true, useNewUrlParser: true })
const dummy = {
  _meta: {
    privateKey: undefined
  },
  id: 'https://localhost/u/dummy',
  type: 'Person',
  following: 'https://localhost/u/dummy/following',
  followers: 'https://localhost/u/dummy/followers',
  liked: 'https://localhost/u/dummy/liked',
  inbox: 'https://localhost/u/dummy/inbox',
  outbox: 'https://localhost/u/dummy/outbox',
  preferredUsername: 'dummy',
  name: 'dummy group',
  summary: 'dummy',
  publicKey: {
    id: 'https://localhost/u/dummy#main-key',
    owner: 'https://localhost/u/dummy',
    publicKeyPem: undefined
  },
  '@context': [
    'https://www.w3.org/ns/activitystreams',
    'https://w3id.org/security/v1'
  ]
}
const activity = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  type: 'Create',
  to: ['https://ignore.com/u/ignored'],
  actor: 'https://localhost/u/dummy',
  object: {
    type: 'Note',
    attributedTo: 'https://localhost/u/dummy',
    to: ['https://ignore.com/u/ignored'],
    content: 'Say, did you finish reading that book I lent you?'
  }
}

app.use(express.json({ type: apex.pub.consts.jsonldTypes }), apex)
app.get('/outbox/:actor', apex.net.outbox.get)
app.post('/outbox/:actor', apex.net.outbox.post)
app.use(function (err, req, res, next) {
  console.log(err)
  next(err)
})

describe('outbox', function () {
  beforeAll(function (done) {
    generateKeyPairPromise('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    }).then(pair => {
      dummy._meta.privateKey = pair.privateKey
      dummy.publicKey.publicKeyPem = pair.publicKey
      return client.connect({ useNewUrlParser: true })
    }).then(done)
  })
  beforeEach(function (done) {
    // block federation attempts
    nock('https://ignore.com')
      .get(() => true)
      .reply(200, {})
      .persist()
      .post(() => true)
      .reply(200)
      .persist()
    // reset db for each test
    client.db('apexTestingTempDb').dropDatabase()
      .then(() => {
        apex.store.connection.setDb(client.db('apexTestingTempDb'))
        return apex.store.setup(dummy)
      })
      .then(done)
  })
  afterEach(function () {
    nock.cleanAll()
  })
  describe('post', function () {
    // validators jsonld
    it('ignores invalid body types', function (done) {
      request(app)
        .post('/outbox/dummy')
        .send({})
        .expect(404, done)
    })
    // validators activity
    it('errors invalid activities', function (done) {
      request(app)
        .post('/outbox/dummy')
        .set('Content-Type', 'application/activity+json')
        .send({})
        .expect(400, 'Invalid activity', done)
    })
    // activity getTargetActor
    it('errors on unknown actor', function (done) {
      request(app)
        .post('/outbox/noone')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(404, '\'noone\' not found on this instance', done)
    })
    // activity save
    it('saves activity in stream', function (done) {
      request(app)
        .post('/outbox/dummy')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(200)
        .then(() => {
          return apex.store.connection.getDb()
            .collection('streams')
            .findOne({ actor: 'https://localhost/u/dummy' })
        })
        .then(act => {
          delete act._meta
          delete act._id
          delete act.id
          delete act.object.id
          expect(act).toEqual(activity)
          done()
        })
        .catch(done)
    })
    it('saves object from activity', function (done) {
      request(app)
        .post('/outbox/dummy')
        .set('Content-Type', 'application/activity+json')
        .send(activity)
        .expect(200)
        .then(() => {
          return apex.store.connection.getDb()
            .collection('objects')
            .findOne({ attributedTo: 'https://localhost/u/dummy' })
        })
        .then(o => {
          delete o._meta
          delete o._id
          expect(o.id).not.toBeFalsy()
          delete o.id
          expect(o).toEqual(activity.object)
          done()
        })
        .catch(done)
    })
    it('wraps a bare object in a create activity', function (done) {
      request(app)
        .post('/outbox/dummy')
        .set('Content-Type', 'application/activity+json')
        .send(activity.object)
        .expect(200)
        .then(() => {
          return apex.store.connection.getDb()
            .collection('streams')
            .findOne({ actor: 'https://localhost/u/dummy' })
        })
        .then(act => {
          expect(act.type).toBe('Create')
          delete act.object.id
          expect(act.object).toEqual(activity.object)
          done()
        })
        .catch(done)
    })
    it('delivers messages to federation targets', function (done) {
      const act = Object.assign({}, activity)
      act.to = ['https://mocked.com/user/mocked']
      nock('https://mocked.com')
        .get('/user/mocked')
        .reply(200, { id: 'https://mocked.com/user/mocked', inbox: 'https://mocked.com/inbox/mocked' })
      nock('https://mocked.com').post('/inbox/mocked')
        .reply(200)
        .on('request', (req, interceptor, body) => {
          // correctly formed activity sent
          const sentActivity = JSON.parse(body)
          delete sentActivity.id
          delete sentActivity.object.id
          expect(sentActivity).toEqual(act)
          // valid signature
          req.originalUrl = req.path
          const sigHead = httpSignature.parse(req)
          expect(httpSignature.verifySignature(sigHead, dummy.publicKey.publicKeyPem)).toBeTruthy()
          done()
        })
      request(app)
        .post('/outbox/dummy')
        .set('Content-Type', 'application/activity+json')
        .send(act)
        .expect(200)
        .end(function (err) {
          if (err) throw err
        })
    })
  })
  describe('get', function () {
    it('returns outbox as ordered collection', (done) => {
      const outbox = [1, 2, 3].map(i => {
        const a = Object.assign({}, activity, { id: `${activity.id}${i}` })
        a.object = Object.assign({}, a.object, { id: `${a.object.id}${i}` })
        return a
      })
      apex.store.connection.getDb()
        .collection('streams')
        .insertMany(outbox)
        .then(inserted => {
          const outboxCollection = {
            '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
            type: 'OrderedCollection',
            totalItems: 3,
            // sort chronological, and remove internal artifacts
            orderedItems: outbox.reverse().map(act => {
              delete act['@context']
              delete act._id
              // delete act._meta
              return act
            })
          }
          expect(inserted.insertedCount).toBe(3)
          request(app)
            .get('/outbox/dummy')
            .set('Accept', 'application/activity+json')
            .expect(200, outboxCollection, done)
        })
    })
  })
})