process.title = "osu-stocks";
require("dotenv").config();
const querystring = require("querystring");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const cookieEncrypter = require("cookie-encrypter");
const express = require("express");
const request = require("request");
const http = require("http");
const https = require("https");
const app = express();
const fs = require("fs");
const f = require('util').format;

const privateKey = fs.readFileSync(process.env.PRIVKEYPATH, "utf8");
const certificate = fs.readFileSync(process.env.CERTPATH, "utf8");

const rootdir = process.env.ROOTDIR;

const credentials = { key: privateKey, cert: certificate };

const cookie_secret = process.env.COOKIE_SECRET;

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

var dbuser = encodeURIComponent(process.env.DBUSER);
var dbpassword = encodeURIComponent(process.env.DBPASS);
var authMechanism = 'DEFAULT';
var MongoClient = require("mongodb").MongoClient;
var dburl = process.env.DBIP;
var url = f('mongodb://%s:%s@%s:27017/osu-stocks?authMechanism=%s',
  dbuser, dbpassword, dburl, authMechanism);

app.use(cookieParser(cookie_secret)).use(cookieEncrypter(cookie_secret));

var dbo;

MongoClient.connect(url, function (err, db) {
  if (err) throw err;
  dbo = db.db("osu-stocks");
});

var stocks = {};
var users = {};
function initialize_objects() {
    dbo
      .collection("inventory")
      .find({})
      .toArray(function (err, result) {
        if (err) throw err;
        for (stock in result)
          stocks[result[stock].user.user.id.toString()] = result[stock];
        //console.log(stocks);
      });
    dbo
      .collection("users")
      .find({})
      .toArray(function (err, result) {
        if (err) throw err;
        for (user in result)
          users[result[user].user.id.toString()] = result[user];
      });
}

function find_user(user, res) {
  var res;
    if (err) throw err;
    var dbo = db.db("osu-stocks");
    var query = { "user.user.username": user };
    dbo
      .collection("inventory")
      .find(query)
      .toArray(function (err, result) {
        if (err) throw err;
        res.send(result);
      });
}

async function get_stock(stock, res) {
  var dbres = await dbo
    .collection("inventory")
    .findOne(
      { "user.user.id": parseInt(stock, 10) },
      { projection: { _id: 0, price: 1, "user.user.username": 1, "user.user.id": 1, shares: 1 } }
    );
  //console.log(stock, dbres);
  res.send(dbres);
}

function get_leaderboard(res) {
  var string = "[";
  var result = [];
  for (stock in stocks) {
    //console.log(stock);
    result.push({
      username: stocks[stock].user.user.username,
      rank: stocks[stock].user.global_rank,
      pp: stocks[stock].user.pp,
      price: stocks[stock].price,
    });
  }
  result.sort(function (a, b) {
    return b.price - a.price;
  });
  for (player in result) {
    if (player == result.length - 1)
      string += JSON.stringify(result[player]) + "]";
    else string += JSON.stringify(result[player]) + ",\n";
  }
  res.type("application/json");
  res.send(string);
}

var cc_refresh_token = fs.readFileSync(rootdir + "/refresh_token", "utf8");
var cc_access_token;
(function first_token() {
  var options = {
    url: "https://osu.ppy.sh/oauth/token",
    body: {
      client_id: client_id,
      client_secret: client_secret,
      grant_type: "refresh_token",
      scope: "public",
      refresh_token: cc_refresh_token,
    },
    json: true,
  };
  request.post(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      console.log(body);
      cc_access_token = body.access_token;
      cc_refresh_token = body.refresh_token;
      fs.writeFileSync(rootdir + "/refresh_token", body.refresh_token);
      first_leaderboard(1);
      //get_users();
    } else console.log("error authenticating");
  });
  setTimeout(get_token, 1800000);
})();

function get_token() {
  var options = {
    url: "https://osu.ppy.sh/oauth/token",
    body: {
      client_id: client_id,
      client_secret: client_secret,
      grant_type: "refresh_token",
      scope: "public",
      refresh_token: cc_refresh_token,
    },
    json: true,
  };
  request.post(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      console.log(body);
      cc_access_token = body.access_token;
      refresh_token = body.refresh_token;
      fs.writeFileSync(rootdir + "/refresh_token", body.refresh_token);
    } else console.log("error authenticating");
  });
  setTimeout(get_token, 8640000);
}

async function get_users() {
  for (const [key, value] of Object.entries(users)) {
    var options = {
      url: `https://osu.ppy.sh/api/v2/users/${key}/osu`,
      headers: { Authorization: "Bearer " + cc_access_token },
    };
    try {
      const response = await fetch(options.url, {
        method: "GET",
        headers: options.headers,
      });
      json = await response.json();
      users[key].user = json;
    } catch (error) {
      console.log("error" + error);
    }
  }
}

async function first_leaderboard(page) {
  if (page) {
    //console.log("page", page);
    var options = {
      url:
        "https://osu.ppy.sh/api/v2/rankings/osu/performance?filter=friends&cursor[page]=" +
        page,
      headers: { Authorization: "Bearer " + cc_access_token },
    };
    try {
      const response = await fetch(options.url, {
        method: "GET",
        headers: options.headers,
      });
      json = await response.json();
      var myobj = json.ranking;
      //update_stocks(myobj);
      for (var i = 0; i < myobj.length; i++) {
        var players = await dbo
          .collection("inventory")
          .findOne({ "user.user.id": myobj[i].user.id });
        if (!players && myobj[i]) {
          console.log("new user added: ", myobj[i].user.id);
          await dbo.collection("inventory").insertOne({
            user: myobj[i],
            shares: { total: 100000, bought: 0 },
            price: myobj[i].pp / 100,
            "pp-30": [{ date: Date.now(), pp: myobj[i].pp }],
          });
        }
      }
      if (json.cursor) setTimeout(first_leaderboard, 1000, json.cursor.page);
      else {
        console.log("made leaderboard.");
        initialize_objects();
        setTimeout(update_leaderboard, 1000, 1);
      }
    } catch (error) {
      console.log("error" + error);
    }
  }
}

async function update_stocks(ranking) {
  for (stock in ranking) {
    var id_str = ranking[stock].user.id.toString();
    stocks[id_str].user = ranking[stock];
    var counter = 0;
    for (j in stocks[id_str]["pp-30"]) {
      if (Date.now() - stocks[id_str]["pp-30"][j].date > 7776000000) {
        counter++;
      } else {
        break;
      }
    }
    for (j = 0; j < counter; j++) {
      stocks[id_str]["pp-30"].shift();
    }

    var market_multiplier =
      1 / (1 - stocks[id_str].shares.bought / stocks[id_str].shares.total);
    var pp30_thing = 0;
    var pp30_sum = 0;
    for (
      var pp30_idx = 1;
      pp30_idx < stocks[id_str]["pp-30"].length;
      pp30_idx++
    ) {
      pp30_sum += pp30_idx;
    }
    for (
      var pp30_idx = 0;
      pp30_idx < stocks[id_str]["pp-30"].length - 1;
      pp30_idx++
    ) {
      pp30_thing +=
        (stocks[id_str]["pp-30"][pp30_idx + 1].pp -
          stocks[id_str]["pp-30"][pp30_idx].pp) *
        (pp30_idx + 1);
    }

    pp30_thing *= 1 / pp30_sum;
    var price =
      ((ranking[stock].pp * (1 + (50 * pp30_thing) / ranking[stock].pp)) /
        100) *
      market_multiplier;
    stocks[id_str].price = price;
    var last_daypp_30 =
      stocks[id_str]["pp-30"][stocks[id_str]["pp-30"].length - 1];
    if (last_daypp_30.date < Date.now() - 86400000) {
      stocks[id_str]["pp-30"].push({
        date: Date.now(),
        pp: ranking[stock].pp,
      });
    }
    await dbo
      .collection("inventory")
      .replaceOne({ _id: stocks[id_str]._id }, stocks[id_str]);
  }
}

async function update_leaderboard(page) {
  if (page) {
    //console.log("page", page);
    var options = {
      url:
        "https://osu.ppy.sh/api/v2/rankings/osu/performance?filter=friends&cursor[page]=" +
        page,
      headers: { Authorization: "Bearer " + cc_access_token },
    };
    try {
      const response = await fetch(options.url, {
        method: "GET",
        headers: options.headers,
      });
      json = await response.json();
      var myobj = json.ranking;
      update_stocks(myobj).then(() => {
        if (json.cursor) setTimeout(update_leaderboard, 500, json.cursor.page);
        else {
          console.log("updated leaderboard.");
          setTimeout(update_leaderboard, 500, 1);
        }
      });
    } catch (error) {
      console.log("error" + error);
    }
  }
}

//app.use(express.static('.'));
app.use(cookieParser(cookie_secret)).use(cookieEncrypter(cookie_secret));

app.use(express.static(rootdir + "/pubdir"));


app.get("/stock", function (req, res) {
  var stock = req.query.stock;
  get_stock(stock, res);
});

app.get("/me", function (req, res) {
  if (req.cookies["access_token"]) {
    get_user(req.cookies["access_token"], req.signedCookies["session"], res);
  } else if (req.signedCookies["refresh_token"]) {
    res.redirect("/refresh_token");
  } else {
    res.redirect("/login");
  }
  //get_users();
});

async function get_user(access_token, id, res) {
  var options = {
    url: "https://osu.ppy.sh/api/v2/me/osu",
    headers: { Authorization: "Bearer " + access_token },
  };
  try {
    const response = await fetch(options.url, {
      method: "GET",
      headers: options.headers,
    });
    json = await response.json();
    //res.send(users[id.toString()]);
    res.send(json);
  } catch (error) {
    console.log("error" + error);
    res.send("error" + error);
  } /**
  console.log(id);
  var db = await MongoClient.connect(url);
  var dbo = await db.db("osu-stocks");
  var dbres = await dbo
    .collection("users")
    .findOne({ "user.id": parseInt(id) });
  res.send(dbres.user);**/
}

app.get("/rankings", function (req, res) {
  get_leaderboard(res);
});
app.get("/login", function (req, res) {
  var referer = req.header("Referer") || "https://stocks.jmir.xyz";

  if (req.signedCookies["access_token"]) {
    res.redirect("/me");
  } else if (req.signedCookies["refresh_token"]) {
    res.redirect("/refresh_token");
  } else {
    // your application requests authorization
    res.redirect(
      "https://osu.ppy.sh/oauth/authorize?" +
        querystring.stringify({
          response_type: "code",
          client_id: client_id,
          state: "state",
          scope: "public identify",
          redirect_uri: "https://stocks.jmir.xyz/callback",
        })
    );
  }
});

app.get("/callback", function (req, res) {
  // your application requests refresh and access tokens

  var code = req.query.code || null;
  if (code) {
    //console.log(state, code);
    var authOptions = {
      url: "https://osu.ppy.sh/oauth/token",
      body: {
        client_id: client_id,
        client_secret: client_secret,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: "https://stocks.jmir.xyz/callback",
      },
      json: true,
    };

    request.post(authOptions, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        var access_token = body.access_token,
          refresh_token = body.refresh_token;
          //expires_in = body.expires_in;
        var cookieParams = {
          signed: true,
          httpOnly: true,
          maxAge: 86400000,
        };
        var accessCookieParams = {
          plain: true,
          httpOnly: true,
          maxAge: 86400000,
        };
        res.cookie("access_token", access_token, accessCookieParams);
        res.cookie("refresh_token", refresh_token, cookieParams);
        console.log(refresh_token);
        var options = {
          url: "https://osu.ppy.sh/api/v2/me/osu",
          headers: { Authorization: "Bearer " + access_token },
        };
        request.get(options, function (error, response, body) {
          var result = JSON.parse(body);
          console.log(result);
          res.cookie("session", result.id, cookieParams);
          login_user(result);
          res.redirect("/me");
        });
        //console.log(state);
        //if (state) res.redirect(state);
      } else {
        res.redirect(
          "/#" +
            querystring.stringify({
              error: "error",
            })
        );
      }
    });
  } else {
    res.redirect(
      "/#" +
        querystring.stringify({
          error: "error",
        })
    );
  }
});

async function login_user(userres) {
  var db = await MongoClient.connect(url);
  var dbo = await db.db("osu-stocks");
  var dbres = await dbo.collection("users").findOne({ "user.id": userres.id });
  if (json.id && !dbres)
    await dbo
      .collection("users")
      .insertOne({ user: userres, shares: {}, net_worth: 0 });
}

app.get("/refresh_token", function (req, res) {
  var referer = req.get("Referer") || "/me";
  if (req.cookies["access_token"]) {
    res.redirect("/me");
  } else {
    // requesting access token from refresh token
    var options = {
      url: "https://osu.ppy.sh/oauth/token",
      body: {
        client_id: client_id,
        client_secret: client_secret,
        grant_type: "refresh_token",
        scope: "public",
        refresh_token: req.signedCookies["refresh_token"],
      },
      json: true,
    };
    request.post(options, function (error, response, body) {
      console.log(error, body);
      if (!error && response.statusCode === 200) {
        var access_token = body.access_token;
        refresh_token = body.refresh_token;
        var expires_in = body.expires_in;
        var cookieParams = {
          signed: true,
          httpOnly: true,
          maxAge: 86400000,
        };
        var accessCookieParams = {
          plain: true,
          httpOnly: true,
          maxAge: 86400000,
        };
        res.cookie("access_token", access_token, accessCookieParams);
        res.cookie("refresh_token", refresh_token, cookieParams);
        res.redirect(referer);
      } else res.send("error authenticating");
    });
  }
});

const httpServer = http.createServer(app);
const httpsServer = https.createServer(credentials, app);
httpsServer.listen(8444);
httpServer.listen(8480);
