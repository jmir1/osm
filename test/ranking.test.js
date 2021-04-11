const app = require('../app');
const chai = require('chai');
const chaiHttp = require('chai-http');
const { expect } = require('chai');
chai.use(chaiHttp);

describe("Rankings endpoint", () => {
    beforeEach((done) => {
        // Any code to run before starting the test suite.
        // Usually used to delete demo data;

        done();
    });

    describe('GET /rankings', () => {
        it("Should return all rankings", (done) => {
            chai.request(app)
                .get("/api/rankings")
                .end((err, res) => {
                    expect(res).to.have.status(200);
                    expect(res.body).to.be.instanceOf(Array);
                    done();
                })
        })
    })

    describe("GET /stock", () => {
        it("Should return the stock status for an individual player", (done) => {
            chai.request(app)
                .get("/api/stock?stock=7562902")
                .end((err, res) => {
                    expect(res).to.have.status(200);
                    expect(res.body).to.be.instanceOf(Object);
                    expect(res.body.id).to.be.instanceOf(Number);
                    expect(res.body.username).to.be.instanceOf(String);
                    expect(res.body.price).to.be.instanceOf(Number);

                })
        })
    })
})



