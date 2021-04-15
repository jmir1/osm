process.title = "osm";
require("dotenv").config();
const querystring = require("querystring");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const cookieEncrypter = require("cookie-encrypter");
const express = require("express");
const app = express();
const bodyparser = require("body-parser");
const request = require("request");
const http = require("http");
const fs = require("fs");
const randomstring = require("randomstring");

const rootdir = process.env.ROOTDIR;

const cookie_secret = process.env.COOKIE_SECRET;

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

var MongoClient = require("mongodb").MongoClient;
var url = process.env.DBURL;

app.use(cookieParser(cookie_secret)).use(cookieEncrypter(cookie_secret));

//we establish the mongodb connection and start
var dbo;

MongoClient.connect(
  url,
  {
    useUnifiedTopology: true
  },
  function (err, db) {
    if (err) throw err;
    dbo = db.db("osu-stocks");
    first_token();
  }
);

//we request an access token with the client_credentials method
var cc_access_token;

function first_token() {
  var options = {
    url: "https://osu.ppy.sh/oauth/token",
    body: {
      client_id: client_id,
      client_secret: client_secret,
      grant_type: "client_credentials",
      scope: "public"
    },
    json: true
  };
  request.post(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      console.log("obtained new access token");
      cc_access_token = body.access_token;
      initialize_objects().then(() => {
        update_leaderboard(1);
        update_users();
      });
    } else console.log("error authenticating");
  });
  setTimeout(get_token, 1800000);
}

//function to refresh our token (we do this every 30 minutes)
function get_token() {
  var options = {
    url: "https://osu.ppy.sh/oauth/token",
    body: {
      client_id: client_id,
      client_secret: client_secret,
      grant_type: "client_credentials",
      scope: "public"
    },
    json: true
  };
  request.post(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      try {
        console.log("obtained new access token");
        cc_access_token = body.access_token;
      } catch (error) {
        console.error(body);
      }
    } else console.error("error authenticating");
  });
  setTimeout(get_token, 1800000);
}

//function to get everything from the db into our memory ("stocks" and "users" objects)
var stocks = {};
var users = {};

async function initialize_objects() {
  stocksresult = await dbo.collection("inventory").find({}).toArray();
  for (stock in stocksresult)
    stocks[stocksresult[stock].user.user.id.toString()] = stocksresult[stock];

  var usersresult = await dbo.collection("users").find({}).toArray();
  for (user in usersresult)
    users[usersresult[user].user.id.toString()] = usersresult[user];
  console.log("initialized objects.");
}

//function to continuously update stats
async function update_leaderboard(page) {
  if (page) {
    var options = {
      url:
        "https://osu.ppy.sh/api/v2/rankings/osu/performance?cursor[page]=" +
        page,
      headers: {
        Authorization: "Bearer " + cc_access_token
      }
    };
    try {
      const response = await fetch(options.url, {
        method: "GET",
        headers: options.headers
      });
      json = await response.json();
      var myobj = json.ranking;
      await update_stocks(myobj, page);
    } catch (error) {
      console.log("error" + error);
    }
    if (json.cursor && page < 30)
      //this number (page < x) specifies the cutoff point for when player stats aren't updated any more: e.g. page < 30 means that if a player is not in top 1500, their stats won't update
      setTimeout(update_leaderboard, 500, json.cursor.page);
    else {
      console.log("updated leaderboard.");
      setTimeout(update_leaderboard, 2000, 1);
    }
  }
}

//function to update the values for stocks by getting new pp values and calculating a new price
//it receives an array (called ranking) with osu-api-like user objects
async function update_stocks(ranking, page) {
  var bulkwrite = [];
  //we check if the player stats are supposed to be updated
  for (stock in ranking) {
    var id_str = ranking[stock].user.id.toString();
    if (stocks[id_str]) {
      //update the user part of the stock object
      stocks[id_str].user = ranking[stock];
      //we delete an entry in the pp history if it is more than 90 days old (7776000000ms)
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
      //update pp history
      stocks[id_str]["pp-30"][stocks[id_str]["pp-30"].length - 1] = {
        date: Date.now(),
        pp: ranking[stock].pp,
        price: price
      };
      //calculate the supply/demand multiplier
      var market_multiplier =
        1 / (1 - stocks[id_str].shares.bought / stocks[id_str].shares.total);
      //calculate the pp growth multiplier
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
      //final price calculation:
      var price =
        ((ranking[stock].pp * (1 + (50 * pp30_thing) / ranking[stock].pp)) /
          100) *
        market_multiplier;
      //add new entry in the pp history if it is older than 12 hours (43200000ms)
      var last_daypp_30 =
        stocks[id_str]["pp-30"][stocks[id_str]["pp-30"].length - 2];
      if (last_daypp_30.date < Date.now() - 43200000) {
        stocks[id_str]["pp-30"].push({
          date: Date.now(),
          pp: ranking[stock].pp,
          price: price
        });
      }
      //update the price in the stock object
      stocks[id_str].price = price;
      //add replace operation to the bulkwrite (more performance!)
      bulkwrite.push({
        replaceOne: {
          filter: {
            _id: stocks[id_str]._id
          },
          replacement: stocks[id_str]
        }
      });
    } else if (!stocks[id_str] && page <= 20) {
      //this number specifies at what rank new players are added. (20 = top 1000)
      console.log("added user " + id_str);
      //add new user to db
      stocks[id_str] = {
        user: ranking[stock],
        shares: {
          total: 100000,
          bought: 0
        },
        price: ranking[stock].pp / 100,
        "pp-30": [
          {
            date: Date.now() - 1,
            pp: ranking[stock].pp,
            price: ranking[stock].pp / 100
          },
          {
            date: Date.now(),
            pp: ranking[stock].pp,
            price: ranking[stock].pp / 100
          }
        ]
      };
      bulkwrite.push({
        insertOne: {
          document: stocks[id_str]
        }
      });
    }
  }
  //we write the entire page into the db at once for performance reasons
  if (bulkwrite.length > 0)
    await dbo.collection("inventory").bulkWrite(bulkwrite);
}

//function to continuously update users
async function update_users() {
  var bulkwrite = [];
  for (id in users) {
    //update userpage
    var options = {
      url: "https://osu.ppy.sh/api/v2/users/" + users[id].user.id,
      headers: {
        Authorization: "Bearer " + cc_access_token
      }
    };
    try {
      const response = await fetch(options.url, {
        method: "GET",
        headers: options.headers
      });
      json = await response.json();
      users[id].user = json;
    } catch (error) {
      console.log("error" + error);
    }
    //update financials
    let share_worth = 0;
    for (stock_id in users[id].shares) {
      share_worth += users[id].shares[stock_id] * stocks[stock_id].price;
    }
    users[id].share_worth = share_worth;
    //update login tokens
    for (cookie in users[id].sessioncookies) {
      if (users[id].sessioncookies[cookie].date < Date.now() - 86400000) {
        users[id].sessioncookies.splice(cookie, 1);
        console.log("deleted cookie");
      }
    }
    //write to db
    bulkwrite.push({
      replaceOne: {
        filter: {
          _id: users[id]._id
        },
        replacement: users[id]
      }
    });
  }
  if (bulkwrite.length > 0) await dbo.collection("users").bulkWrite(bulkwrite);
  console.log("updated users");
  setTimeout(update_users, 10000, 1);
}

///////////

//cookie-parser for cookies
app.use(cookieParser(cookie_secret)).use(cookieEncrypter(cookie_secret));

//bodyparser for post routes
app.use(
  bodyparser.urlencoded({
    extended: true
  })
);

//static webserver for frontend
app.use(express.static(rootdir + "/index"));
app.get("/api/fetch/columns", function (req, res) {
  res.send({
    keys: {
      username: { name: "username", description: "username" },
      rank: { name: "rank", description: "rank" },
      price: { name: "price", description: "price" },
      id: { name: "id", description: "id" }
    },
    types: {
      anime: [
        {
          key: "username",
          hidden: false
        },
        {
          key: "rank",
          hidden: false
        },
        {
          key: "price",
          hidden: false
        },
        {
          key: "id",
          hidden: false
        }
      ],
      animeDownload: [],
      manga: [],
      novel: [],
      application: []
    }
  });
});
app.get("/api/fetch/data/stocks", function (req, res) {
  const filters = {};
  // Limit example: /api/rankings?limit=100
  if (req.query.limit) {
    filters.limit = parseInt(req.query.limit);
  }

  res.type("application/json");
  res.send(get_leaderboard(filters));
});
//res.send([{features:"lol",siteName:"bruh",siteAddresses:"https://stocks.jmir.xyz"}])
app.get("/user/is-login", function (req, res) {
  res.send({ edit: true });
});
app.get("/api/fetch/tables", function (req, res) {
  res.send([
    {
      tab: "animeTables",
      name: "stocks",
      tables: [
        {
          id: "stocks",
          title: "English Streaming Sites",
          type: "anime"
        }
      ]
    },
    {
      tab: "mangaTables",
      name: "Manga",
      tables: []
    },
    {
      tab: "lightNovelTables",
      name: "Novels",
      tables: []
    },
    {
      tab: "applicationsTables",
      name: "Applications",
      tables: []
    },
    {
      tab: "hentaiTables",
      name: "Hentai",
      tables: []
    }
  ]);
});
//route to get info about a stock
app.get("/api/stock", function (req, res) {
  var stock = req.query.stock;
  res.send(get_stock(stock));
});
//function returns info about a stock
function get_stock(stock) {
  return {
    price: stocks[stock.toString()].price,
    username: stocks[stock.toString()].user.user.username,
    id: stocks[stock.toString()].user.user.id,
    shares: stocks[stock.toString()].shares
  };
}

//route to get info about yourself
app.get("/api/me", function (req, res) {
  if (req.cookies["user_id"] && req.cookies["session"]) {
    res.send(users[req.cookies["user_id"].toString()]);
  } else {
    res.redirect("/");
  }
});

//route to get the stocks sorted by their value
app.get("/api/rankings", function (req, res) {
  const filters = {};
  // Limit example: /api/rankings?limit=100
  if (req.query.limit) {
    filters.limit = parseInt(req.query.limit);
  }

  res.type("application/json");
  res.send(get_leaderboard(filters));
});
//this function formats and returns the stocks sorted by their value
function get_leaderboard(filters) {
  const { limit } = filters;
  // var string = "[";
  var result = [];
  for (stock in stocks) {
    result.push({
      username: stocks[stock].user.user.username,
      rank: stocks[stock].user.global_rank,
      pp: stocks[stock].user.pp,
      price: stocks[stock].price,
      id: stocks[stock].user.user.id
    });
  }
  result.sort(function (a, b) {
    return b.price - a.price;
  });
  if (limit) {
    result = result.slice(0, limit);
  }
  // Shouldn't be necessary as express will convert arrays/objects to JSON strings
  // for (player in result) {
  //   if (player == result.length - 1)
  //     string += JSON.stringify(result[player]) + "]";
  //   else string += JSON.stringify(result[player]) + ",\n";
  // }
  return result;
}
///*not ready
//route for buying stock
app.post("/api/buy", function (req, res) {
  var stock_id = req.body.stock_id;
  var quantity = req.body.quantity;
  var user_id = req.body.user_id;
  var sessioncookie = req.body.session_cookie;
  if (stock_id && quantity && user_id && sessioncookie) {
    let result = buy_stock(stock_id, quantity, user_id, sessioncookie);
    res.send(result);
  }
});
//function to buy stocks (just a placeholder)
function buy_stock(stock_id, quantity, user_id, token) {
  for (cookie in users[user_id].sessioncookies) {
    if (users[user_id].sessioncookies[cookie].token == token) {
      return {
        balance: users[user_id].balance,
        shares: users[user_id].shares,
        stock: stock_id,
        quantity: quantity,
        msg: "success!"
      };
    }
  }
} //*/

//route for logging in (redirects to osu oauth confirmation page)
app.get("/api/login", function (req, res) {
  var referer = req.header("Referer") || null;
  // your application requests authorization
  res.redirect(
    "https://osu.ppy.sh/oauth/authorize?" +
      querystring.stringify({
        response_type: "code",
        client_id: client_id,
        state: referer,
        scope: "public identify",
        redirect_uri: process.env.REDIRECT_URI
      })
  );
});

//route used to ultimately log you in
app.get("/api/callback", function (req, res) {
  var state = req.query.state || null;
  var code = req.query.code || null;
  if (code) {
    var authOptions = {
      url: "https://osu.ppy.sh/oauth/token",
      body: {
        client_id: client_id,
        client_secret: client_secret,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: process.env.REDIRECT_URI
      },
      json: true
    };
    request.post(authOptions, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        var access_token = body.access_token;
        expires_in = body.expires_in;
        var cookieParams = {
          plain: true,
          httpOnly: true,
          maxAge: expires_in * 1000
        };
        var options = {
          url: "https://osu.ppy.sh/api/v2/me/osu",
          headers: {
            Authorization: "Bearer " + access_token
          }
        };
        request.get(options, function (error, response, body) {
          var result = JSON.parse(body);
          console.log(result);
          let token = result.id + randomstring.generate(64);
          res.cookie("session", token, cookieParams);
          res.cookie("user_id", result.id, cookieParams);
          console.log(result.id + token);
          login_user(result, token, expires_in);
          if (state) res.redirect(state);
          else res.redirect("/api/me");
        });
      } else {
        res.redirect(
          "/#" +
            querystring.stringify({
              error: "error"
            })
        );
      }
    });
  } else {
    res.redirect(
      "/#" +
        querystring.stringify({
          error: "error"
        })
    );
  }
});

//function for logging the user in
async function login_user(userres, sessioncookie, expires_in) {
  if (users[userres.id.toString()]) {
    users[userres.id.toString()].sessioncookies.push({
      date: Date.now() + expires_in * 1000,
      token: sessioncookie
    });
  } else {
    users[userres.id.toString()] = {
      user: userres,
      shares: {},
      share_worth: 0,
      balance: 100000,
      sessioncookies: [
        {
          date: Date.now() + expires_in * 1000,
          token: sessioncookie
        }
      ]
    };
    await dbo.collection("users").insertOne(users[userres.id.toString()]);
  }
}

//start the server
const httpServer = http.createServer(app);
httpServer.listen(process.env.PORT);

// For testing
module.exports = app;

/*don't need all this right now
app.get("/api/refresh_token", function (req, res) {
  var referer = req.get("Referer") || "/api/me";
  if (req.cookies["access_token"]) {
    res.redirect("/api/me");
  } else {
    // requesting access token from refresh token
    var options = {
      url: "https://osu.ppy.sh/oauth/token",
      body: {
        client_id: client_id,
        client_secret: client_secret,
        grant_type: "refresh_token",
        scope: "public",
        refresh_token: req.cookies["refresh_token"],
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
          plain: true,
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
});*/
/*
async function get_users() {
  for (const [key, value] of Object.entries(users)) {
    var options = {
      url: `https://osu.ppy.sh/api/v2/users/${key}/osu`,
      headers: {
        Authorization: "Bearer " + cc_access_token
      },
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
*/
/*
function find_user(user, res) {
  var res;
  if (err) throw err;
  var dbo = db.db("osu-stocks");
  var query = {
    "user.user.username": user
  };
  dbo
    .collection("inventory")
    .find(query)
    .toArray(function (err, result) {
      if (err) throw err;
      res.send(result);
    });
}*/
