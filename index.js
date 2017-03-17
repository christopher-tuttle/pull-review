'use strict';

var yaml = require('js-yaml');
var shuffle = require('knuth-shuffle');
var Promise = require('native-promise-only');

var SUPPORTED_CONFIG_VERSIONS = [1];

//todo: jsdoc
//todo: AUTHORS/OWNERS integration
//todo: consider fixturing a real pull request
//todo: example usage

function BlameRange(input) {
  var login = input.login;
  var count = input.count;
  var age = input.age;

  if (!login || !count || !age) {
    throw Error('Missing blame range data');
  }

  return input;
}

function PullRequestFile(input) {
  var filename = input.filename;
  var status = input.status;
  var changes = input.changes;

  if (!filename || !status || changes === undefined) {
    throw Error('Missing file data');
  }

  return input;
}

function PullReviewConfig(input) {
  var config = input;

  if (typeof input === 'string') {
    config = yaml.safeLoad(input);
  }

  if (!config) {
    throw Error('Invalid config');
  }

  if (!config.version || SUPPORTED_CONFIG_VERSIONS.indexOf(config.version) === -1) {
    throw Error('Missing or unsupported config version. Supported versions include: ' + SUPPORTED_CONFIG_VERSIONS.join(', '));
  }

  function get(value, defaultValue) {
    return value !== undefined ? value : defaultValue;
  }

  var minReviewers = get(config.min_reviewers, 1);
  var maxReviewers = get(config.max_reviewers, 2);
  var maxFiles = get(config.max_files, 5);
  var maxFilesPerReviewer = get(config.max_files_per_reviewer, 0);
  var assignMinReviewersRandomly = get(config.assign_min_reviewers_randomly, true);
  var reviewers = get(config.reviewers, {});
  var reviewBlacklist = get(config.review_blacklist, []);
  var reviewPathFallbacks = get(config.review_path_fallbacks, null);
  var requireNotification = get(config.require_notification, true);

  if (minReviewers < 0 || minReviewers === Infinity) {
    throw Error('Invalid number of minimum reviewers');
  } else if (maxReviewers < 0 || maxReviewers === Infinity) {
    throw Error('Invalid number of maximum reviewers');
  } else if (minReviewers > maxReviewers) {
    throw Error('Minimum reviewers exceeds maximum reviewers');
  } else if (maxFiles < 0 || maxFiles === Infinity) {
    throw Error('Invalid number of maximum files');
  } else if (maxFilesPerReviewer < 0 || maxFilesPerReviewer === Infinity) {
    throw Error('Invalid number of maximum files per reviewer');
  }

  config = {
    'minReviewers': minReviewers,
    'maxReviewers': maxReviewers,
    'maxFiles': maxFiles,
    'maxFilesPerReviewer': maxFilesPerReviewer,
    'reviewers': reviewers,
    'reviewBlacklist': reviewBlacklist,
    'reviewPathFallbacks': reviewPathFallbacks,
    'requireNotification': requireNotification,
    'assignMinReviewersRandomly': assignMinReviewersRandomly
  };

  return config;
}

function PullReviewAssignment(options) {
  var config = options.config || {
    'version': 1
  };
  var files = options.files || [];
  var assignees = options.assignees || [];
  var authorLogin = options.authorLogin;
  var getBlameForFile = options.getBlameForFile;
  var currentReviewers = {};

  if (!getBlameForFile) {
    throw Error('No function provided for retrieving blame for a file');
  } else if (!authorLogin) {
    throw Error('No pull request author provided');
  }

  config = PullReviewConfig(config);

  files = files.map(PullRequestFile);

  var modifiedFiles = files.filter(function(file) {
    return file.status === 'modified';
  });

  modifiedFiles.sort(function(a, b) {
    return b.changes - a.changes;
  });

  var topModifiedFiles = config.maxFiles > 0 ? modifiedFiles.slice(0, config.maxFiles) : modifiedFiles;

  var maxReviewers = config.maxReviewers;
  var minReviewers = config.minReviewers;
  var maxFilesPerReviewer = config.maxFilesPerReviewer;

  assignees = assignees.filter(function(assignee) {
    return assignee !== authorLogin;
  });

  if (assignees.length >= maxReviewers) {
    throw Error('Pull request has maximum reviewers assigned');
  } else if (assignees.length >= minReviewers) {
    throw Error('Pull request has minimum reviewers assigned');
  }

  var unassignedReviewers = maxReviewers - assignees.length;
  var maxNeededReviewers = maxFilesPerReviewer > 0 ? Math.ceil(files.length / maxFilesPerReviewer) : unassignedReviewers;
  var maxReviewersAssignable = Math.min(unassignedReviewers, maxNeededReviewers);
  var minReviewersAssignable = maxFilesPerReviewer > 0 ? maxReviewersAssignable : minReviewers;

  function isEligibleReviewer(reviewer) {
    var isReviewerSelected = currentReviewers[reviewer];
    var isReviewerAuthor = reviewer === authorLogin;
    var isReviewerUnreachable = (config.requireNotification ? !config.reviewers[reviewer] : false);
    var isReviewerBlacklisted = config.reviewBlacklist && config.reviewBlacklist.indexOf(reviewer) !== -1;
    return !isReviewerSelected && !isReviewerAuthor && !isReviewerBlacklisted && !isReviewerUnreachable;
  }

  return Promise.all(topModifiedFiles.map(getBlameForFile))
    .then(function(blames) {
      var authorsLinesChanged = {};

      for (var i = 0; i < blames.length; i++) {
        var ranges = (blames[i] || []).map(BlameRange);

        ranges.sort(function(a, b) {
          return a.age - b.age;
        });

        var usableBlames = ranges.filter(function(range) {
          return isEligibleReviewer(range.login);
        });

        var recentBlames = usableBlames.slice(0, Math.ceil(usableBlames.length * 0.75));

        recentBlames.forEach(function (range) {
          var linesChanged = range.count;
          var author = range.login;

          if (!authorsLinesChanged[author]) {
            authorsLinesChanged[author] = 0;
          }

          authorsLinesChanged[author] += linesChanged;
        });
      }

      var authorBlames = [];

      Object.keys(authorsLinesChanged || {}).forEach(function (author) {
        authorBlames.push({
          'login': author,
          'count': authorsLinesChanged[author] || 0,
          'source': 'blame'
        });
      });

      authorBlames.sort(function(a, b) {
        return b.count - a.count;
      });

      return authorBlames.slice(0, maxReviewersAssignable);
    })
    .then(function(reviewers) {
      var fallbackReviewers = [];
      var randomReviewers = [];

      reviewers.forEach(function (reviewer) {
        currentReviewers[reviewer.login] = true;
      });

      if (reviewers.length < minReviewersAssignable && config.assignMinReviewersRandomly && config.reviewPathFallbacks) {
        Object.keys(config.reviewPathFallbacks || {}).forEach(function (prefix) {
          files.forEach(function (file) {
            if (file.filename.indexOf(prefix) === 0) {
              var fallbackAuthors = config.reviewPathFallbacks[prefix] || [];

              fallbackAuthors.forEach(function (author) {
                if (!isEligibleReviewer(author)) {
                  return;
                }

                fallbackReviewers.push({
                  'login': author,
                  'count': 0,
                  'source': 'fallback'
                });

                currentReviewers[author] = true;
              });
            }
          });
        });

        shuffle.knuthShuffle(fallbackReviewers);
        reviewers = reviewers.concat(fallbackReviewers.slice(0, minReviewersAssignable - reviewers.length));
      }

      if (reviewers.length < minReviewersAssignable && config.assignMinReviewersRandomly) {
        Object.keys(config.reviewers || {}).forEach(function (author) {
          if (!isEligibleReviewer(author)) {
            return;
          }

          randomReviewers.push({
            'login': author,
            'count': 0,
            'source': 'random'
          });

          currentReviewers[author] = true;
        });

        shuffle.knuthShuffle(randomReviewers);
        reviewers = reviewers.concat(randomReviewers.slice(0, minReviewersAssignable - reviewers.length));
      }

      return reviewers;
    })
    .then(function(reviewers) {
      return reviewers.map(function(reviewer) {
        reviewer.notify = config.reviewers[reviewer.login];
        return reviewer;
      });
    });
}

module.exports = {
  'PullReviewConfig': PullReviewConfig,
  'PullReviewAssignment': PullReviewAssignment
};