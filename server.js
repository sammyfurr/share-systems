// Database
/*
 * We're keeping it simple and just using a quick Mongodb database
 * User profiles look like this:
 * _id: id
 * githubDisplayName: displayName
 * githubUsername: username
 * type: student | teacher
 */

const MongoClient = require('mongodb').MongoClient;
const assert = require('assert');

// Our username and password for database are kept secret in the env file
const uri = "mongodb+srv://" + process.env.USER + ":" + process.env.PASS + "@share-systems-pc5dt.mongodb.net/test?retryWrites=true&w=majority";

/**
 * Changes id to _id to key properly with database in profile
 * @param  {Object} profile A user profile.
 * @return {Object}         Properly formated user.
 */
function formatUser(profile){
  var id = profile.id
  delete profile.id;
  profile['_id'] = id;
  return profile;
}

/**
 * Finds a user in the database, or creates them if they don't exist
 * @param {Object}   profile A user profile.
 * @param {Function} cb      Callback function.
 */
async function findCreateUser(profile, cb){
  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true});
  
  // Await the connection so we don't close before we're all done!
  await client.connect( (err, client) => {  
    assert.equal(null, err);
    
    const db = client.db('sharedb');
    const users = db.collection('users');
    
    // Try to find the user who matches our login attempt, or verification attempt.
    users.find({_id: profile._id}).limit(1).toArray( (err, docs) => {
      try{
        assert.equal(null, err);
        assert.equal(1, docs.length);
        // We found the user--great!  Now callback to extract them without error.
        cb(null, docs[0]);
        client.close();
      } catch (e) { // We didn't find the user--create them.
        var user = { 
          _id: profile._id, 
          githubDisplayName: profile.displayName,
          githubUsername: profile.username,
          type: 'student' // You have to manually set people to teachers in the backend for now.
        };
        users.insertOne(user, (err, docs) => {
          assert.equal(null, err);       
          // Find the user we just created
          users.find({_id: profile._id}).limit(1).toArray( (err, docs) => {
            assert.equal(null, err);
            assert.equal(1, docs.length);
            client.close();
            cb(null, docs[0]);
          });
        });
      }
    });
  });
}

// Authentication
/* We're using passport to authenticate users through github, since the code they'll be sharing is in
 * git repos.
 */
const express = require('express');
const session = require('express-session');
const path = require('path');
const passport = require('passport');
const GitHubStrategy = require('passport-github').Strategy;

passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.URL + "/auth/github/callback"
  },
  function(accessToken, refreshToken, profile, cb) {
    findCreateUser(formatUser(profile), (err, user) => {
      return cb(err, user);
    });
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, findCreateUser(user, (err, user) => {
      return user;
    }));
});

/**
 * Checks if a user is logged in.
 */
function loggedIn(req, res, next) {
  if (req.session.passport.user) {
    next();
  } else {
    res.redirect('/')
  }
}

// Track Students
class Students{
  constructor(){
    this.students = {}
  }
  
  addStudent(student){
    this.students[student._id] = {user: student, current: false, code: null};
  }
  
  removeStudent(id){
    delete this.students[id];
  }
  
  getStudent(id){
    return this.students[id];
  }
  
  selectStudent(id){
    for(var student in this.students){
      if(this.students[student].current == true){
        this.students[student].current = false;
      }
    }
    this.students[id].current = true;
  }
  
  updateCode(id, code){
    console.log(id + code);
    this.students[id]['code'] = code;
    console.log(this.students);
  }
  
  getStudents(){
    var s = []
    for (const id in this.students){
      s.push(this.students[id].user);
    }
    return s;
  }
}

var students = new Students();

var app = express();
var http = require('http').createServer(app);
var io = require('socket.io')(http);

app.use(require('express-session')({ secret: process.env.EXPRESS_SECRET, resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

// Expose node_modules so monaco will load itself
app.use(express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Users log in from homepage
app.get('/', (req, res) => {
  res.render('pages/index');
});

// User's code view
app.get('/code', loggedIn, (req, res, next) => {
    res.render('pages/code', {user: req.session.passport.user});
  }
);

// User's teach view
app.get('/teach', loggedIn, (req, res, next) => {
    var s = students.getStudents();
    res.render('pages/teach', {
      user: req.session.passport.user,
      students: s
    });
  }
);

// Authorization attempt
app.get('/auth/github',
  passport.authenticate('github'));

// On return from authorization
app.get('/auth/github/callback', 
  passport.authenticate('github', { failureRedirect: '/' }),
  function(req, res) {
    var user = req.session.passport.user;
    // Successful authentication, redirect home.
    if(user.type == 'teacher'){
      res.redirect('/teach');
    } else {
      students.addStudent(user);
      res.redirect('/code');
    }
  });

// Log the user out of the session
app.get('/logout', function(req, res){
  students.removeStudent(req.session.passport.user._id);
  req.logout();
  res.redirect('/');
});

// IO with the student's code
const nsp = io.of('/teach');
nsp.on('connection', function(socket){
  socket.on('select', (msg) => {
    students.selectStudent(msg.id);
    nsp.emit('code', students.getStudent(msg.id).code);
  });
});

io.on('connection', function(socket){
  socket.on('code', function(msg){
    students.updateCode(msg.id, msg.editor);
    if (students.getStudent(msg.id).current){
      nsp.emit('code', msg.editor);
    }
  });
});

// listen for requests
var listener = http.listen(process.env.PORT, function() {
  console.log('Your app is listening on port ' + listener.address().port);
});
