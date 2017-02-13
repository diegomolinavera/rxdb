/**
 * The DataMigrator handles the documents from collections with older schemas
 * and transforms/saves them into the newest collection
 */

import {
    default as PouchDB
} from './PouchDB';

import {
    default as clone
} from 'clone';

import * as util from './util';
import * as RxSchema from './RxSchema';
import * as KeyCompressor from './KeyCompressor';
import * as Crypter from './Crypter';

class DataMigrator {

    constructor(newestCollection, migrationStrategies) {
        this.newestCollection = newestCollection;
        this.migrationStrategies = migrationStrategies;
        this.currentSchema = newestCollection.schema;
        this.database = newestCollection.database;
        this.name = newestCollection.name;
    }


    /**
     * get an array with OldCollection-instances from all existing old pouchdb-instance
     * @return {OldCollection[]}
     */
    async _getOldCollections() {
        const oldColDocs = await Promise.all(
            this.currentSchema.previousVersions
            .map(v => this.database._collectionsPouch.get(this.name + '-' + v))
            .map(fun => fun.catch(e => null)) // auto-catch so Promise.all continues
        );
        // spawn OldCollection-instances
        return oldColDocs
            .filter(colDoc => colDoc != null)
            .map(colDoc => new OldCollection(colDoc.schema.version, colDoc.schema, this));
    }

    /**
     * @param {number} [batchSize=10] amount of documents handled in parallel
     * @return {Observable} emits the migration-state
     */
    migrate(batchSize = 10) {
        if (this._migrated)
            throw new Error('Migration has already run');
        this._migrated = true;

        const state = {
            done: false, // true if finished
            total: null, // will be the doc-count
            handled: 0, // amount of handled docs
            success: 0, // handled docs which successed
            deleted: 0, // handled docs which got deleted
            percent: 0 // percentage
        };

        const migrationState$ = new util.Rx.Observable(async(observer) => {
            const oldCols = await this._getOldCollections();

            const countAll = await Promise.all(
                oldCols.map(oldCol => oldCol.countAllUndeleted())
            );
            const total_count = countAll.reduce((cur, prev) => prev = cur + prev, 0);

            state.total = total_count;
            observer.next(clone(state));

            let currentCol = null;
            let error = null;
            while (currentCol = oldCols.shift()) {
                const migrationState$ = currentCol.migrate(batchSize);
                await new Promise(res => {
                    const sub = migrationState$.subscribe(
                        subState => {
                            state.handled++;
                            state[subState.type] = state[subState.type] + 1;
                            state.percent = Math.round(state.handled / state.total * 100);
                            observer.next(clone(state));
                        },
                        e => {
                            error = e;
                            sub.unsubscribe();
                            observer.error(e);
                        }, () => {
                            sub.unsubscribe();
                            res();
                        });
                });

            }

            state.done = true;
            state.percent = 100;
            observer.next(clone(state));

            observer.complete();
        });
        return migrationState$;
    }

    migratePromise(batchSize) {
        if (!this._migratePromise) {
            this._migratePromise = new Promise((res, rej) => {
                const state$ = this.migrate(batchSize);
                state$.subscribe(null, rej, res);
            });
        }
        return this._migratePromise;
    }

}





class OldCollection {
    constructor(version, schemaObj, dataMigrator) {
        this.version = version;
        this.dataMigrator = dataMigrator;
        this.schemaObj = schemaObj;
        this.newestCollection = dataMigrator.newestCollection;
        this.database = dataMigrator.newestCollection.database;
    }
    get schema() {
        if (!this._schema) {
            //            delete this.schemaObj._id;
            this._schema = RxSchema.create(this.schemaObj, false);
        }
        return this._schema;
    }
    get keyCompressor() {
        if (!this._keyCompressor)
            this._keyCompressor = KeyCompressor.create(this.schema);
        return this._keyCompressor;
    }
    get crypter() {
        if (!this._crypter)
            this._crypter = Crypter.create(this.database.password, this.schema);
        return this._crypter;
    }
    get pouchdb() {
        if (!this._pouchdb) {
            this._pouchdb = this.database._spawnPouchDB(
                this.newestCollection.name,
                this.version,
                this.newestCollection.pouchSettings
            );
        }
        return this._pouchdb;
    }

    async countAllUndeleted() {
        return PouchDB.countAllUndeleted(this.pouchdb);
    }
    async getBatch(batchSize) {
        const docs = await PouchDB.getBatch(this.pouchdb, batchSize);
        return docs
            .map(doc => this._handleFromPouch(doc));
    }

    /**
     * handles a document from the pouchdb-instance
     */
    _handleFromPouch(docData) {
        const swapped = this.schema.swapIdToPrimary(docData);
        const decompressed = this.keyCompressor.decompress(swapped);
        const decrypted = this.crypter.decrypt(decompressed);
        return decrypted;
    }

    /**
     * runs the doc-data through all following migrationStrategies
     * so it will match the newest schema.
     * @throws Error if final doc does not match final schema or migrationStrategy crashes
     * @return {Object|null} final object or null if migrationStrategy deleted it
     */
    async migrateDocumentData(doc) {
        doc = clone(doc);
        let nextVersion = this.version + 1;


        // run throught migrationStrategies
        let error = null;
        while (nextVersion <= this.newestCollection.schema.version && !error) {

            doc = await this.dataMigrator.migrationStrategies[nextVersion + ''](doc);

            nextVersion++;
            if (doc == null && !error)
                return null;
        }


        // check final schema
        try {
            this.newestCollection.schema.validate(doc);
        } catch (e) {
            throw new Error(`
              migration of document from v${this.version} to v${this.newestCollection.schema.version} failed
              - final document does not match final schema
              - final doc: ${JSON.stringify(doc)}
            `);
        }
        return doc;
    }



    /**
     * transform docdata and save to new collection
     * @return {{type: string, doc: {}}} status-action with status and migrated document
     */
    async _migrateDocument(doc) {
        const migrated = await this.migrateDocumentData(doc);
        const action = {
            doc,
            migrated
        };

        if (migrated) {
            // save to newest collection
            delete migrated._rev;
            await this.newestCollection._pouchPut(migrated, true);
            action.type = 'success';
        } else action.type = 'deleted';


        // remove from old collection
        try {
            await this.pouchdb.remove(doc);
        } catch (e) {}

        return action;
    }


    /**
     * deletes this.pouchdb and removes it from the database.collectionsCollection
     */
    async delete() {
        await this.pouchdb.destroy();
        await this.database.removeCollectionDoc(this.dataMigrator.name, this.schema);
    }


    /**
     * runs the migration on all documents and deletes the pouchdb afterwards
     */
    migrate(batchSize = 10) {
        if (this._migrate)
            throw new Error('migration already running');
        this._migrate = true;

        const stateStream$ = new util.Rx.Observable(async(observer) => {
            let batch = await this.getBatch(batchSize);
            let error;
            do {
                await Promise.all(
                    batch.map(doc => this._migrateDocument(doc)
                        .then(action => observer.next(action))
                    )
                ).catch(e => error = e);

                if (error) {
                    observer.error(error);
                    return;
                }

                // reset batch so loop can run again
                batch = await this.getBatch(batchSize);
            } while (!error && batch.length > 0);

            // remove this oldCollection
            await this.delete();

            observer.complete();
        });
        return stateStream$;
    }
    migratePromise(batchSize) {
        if (!this._migratePromise) {
            this._migratePromise = new Promise((res, rej) => {
                const state$ = this.migrate(batchSize);
                state$.subscribe(null, rej, res);
            });
        }
        return this._migratePromise;
    }
}


export function create(newestCollection, migrationStrategies) {
    return new DataMigrator(newestCollection, migrationStrategies);
}
