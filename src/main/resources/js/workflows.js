Vue.use(VueTimeago);
Vue.use(vueMoment);

function initWorkflow(w) {
  if (!window.singleWorkflow) {
    delete w.workflow;
  }
  w.runningProcessChains = w.runningProcessChains || 0;
  w.succeededProcessChains = w.succeededProcessChains || 0;
  w.cancelledProcessChains = w.cancelledProcessChains || 0;
  w.failedProcessChains = w.failedProcessChains || 0;
  w.totalProcessChains = w.totalProcessChains || 0;
  w.startTime = w.startTime || null;
  w.endTime = w.endTime || null;
}

if (window.singleWorkflow === undefined) {
  window.singleWorkflow = false;
}

workflows.forEach(initWorkflow);

let app = new Vue({
  el: '#app',
  mixins: [paginationMixin],
  data: {
    workflows: window.workflows,
    page: window.page,
    workflowsAdded: false,
    now: new Date()
  },
  created: function () {
    setInterval(() => {
       this.$data.now = new Date();
    }, 1000);

    if (window.singleWorkflow) {
      this.initWorkflowGraph();
    }
  },
  methods: {
    showCancelModal: function (w) {
      $("#cancel-modal")
        .modal({
          onApprove: function () {
            fetch(basePath + "/workflows/" + w.id, {
              method: "PUT",
              body: JSON.stringify({
                status: "CANCELLED"
              })
            }).catch(error => {
              console.error(error);
            });
          }
        })
        .modal("show");
    },

    findWorkflowById: function (id) {
      for (let workflow of this.workflows) {
        if (workflow.id === id) {
          return workflow;
        }
      }
      return undefined;
    },

    workflowDuration: function (w) {
      let endTime = w.endTime || this.now;
      let duration = Math.ceil(this.$moment.duration(
          this.$moment(endTime).diff(this.$moment(w.startTime))).asSeconds());
      let seconds = Math.floor(duration % 60);
      let minutes = Math.floor(duration / 60 % 60);
      let hours = Math.floor(duration / 60 / 60);
      let result = "";
      if (hours > 0) {
        result += hours + "h ";
      }
      if (result !== "" || minutes > 0) {
        result += minutes + "m ";
      }
      result += seconds + "s";
      return result;
    },

    // convert a workflow to a dagre graph
    workflowToGraph: function (workflow, g) {
      let nextNodeId = 0;

      function varToId(v) {
        if (typeof v === "object" && typeof v.id !== "undefined") {
          v = v.id;
        }
        return v;
      }

      function makeIconLabel(icon, text) {
        return '<span class="icon-container"><i class="' + icon + ' grey icon"></i></span> ' + text;
      }

      // make a graph node
      function makeNode(g, id, label, parent) {
        g.setNode(id, label);
        if (typeof parent !== "undefined") {
          g.setParent(id, parent);
        }
      }

      // make a graph node that represents a file
      function makeFile(g, id, parent) {
        makeNode(g, id, {
          label: makeIconLabel("file outline", id),
          labelType: "html",
          class: "file"
        }, parent);
      }

      // convert a list of actions to graph nodes
      function actionsToGraph(actions, g, parent) {
        actions = actions || [];
        actions.forEach(a => {
          if (a.type === "execute") {
            let id = nextNodeId++;
            makeNode(g, id, {
              // we need an icon container to make the rendering consistent across browsers
              label: makeIconLabel("cog", a.service),
              labelType: "html",
              class: "execute"
            }, parent);
            let inputs = a.inputs || [];
            let outputs = a.outputs || [];
            for (let i of inputs) {
              makeFile(g, varToId(i.var), undefined /* never override parent for inputs */);
              g.setEdge(varToId(i.var), id, {}, id + "$$" + i.id);
            }
            for (let o of outputs) {
              makeFile(g, varToId(o.var), parent);
              g.setEdge(id, varToId(o.var), {}, id + "$$" + o.id);
            }
          } else if (a.type === "for") {
            let id = nextNodeId++;
            makeNode(g, id, {
              label: makeIconLabel("redo", ""),
              labelType: "html",
              class: "for"
            }, parent);
            actionsToGraph(a.actions, g, id);
            if (typeof a.input !== "undefined" && typeof a.enumerator !== "undefined") {
              makeFile(g, a.input, undefined /* never override parent for inputs */);
              makeFile(g, a.enumerator, id);
              g.setEdge(a.input, a.enumerator, {});
            }
            if (typeof a.output !== "undefined" && typeof a.yieldToOutput !== "undefined") {
              makeFile(g, a.output, parent);
              makeFile(g, a.yieldToOutput, id);
              g.setEdge(a.yieldToOutput, a.output, {});
            }
          }
        });
      }

      actionsToGraph(workflow.actions, g);
    },

    createNewGraph: function () {
      return new dagreD3.graphlib.Graph({
        multigraph: true,
        compound: true
      }).setGraph({});
    },

    initWorkflowGraph: function () {
      let invalidGraph = false;
      let g = this.createNewGraph();

      // limit number of nodes and edges
      const MAX_NODES = 500;
      const MAX_EDGES = 500;
      let oldSetNode = g.setNode;
      let oldSetEdge = g.setEdge;
      g.setNode = function() {
        if (g.nodeCount() > MAX_NODES) {
          throw "Too many nodes";
        }
        oldSetNode.apply(g, arguments);
      };
      g.setEdge = function() {
        if (g.edgeCount() > MAX_EDGES) {
          throw "Too many edges";
        }
        oldSetEdge.apply(g, arguments);
      }

      // convert workflow to graph
      try {
        this.workflowToGraph(this.workflows[0].workflow, g);
      } catch (e) {
        // reset graph
        g = this.createNewGraph();
        invalidGraph = true;
      }

      // configure nodes
      g.nodes().forEach(v => {
        let node = g.node(v);
        // rounded borders
        node.rx = node.ry = 4;
      });

      // configure edges
      g.edges().forEach(v => {
        let edge = g.edge(v);
        // set arrow head
        edge.arrowheadClass = "arrowhead";
        // make edges curvy
        edge.curve = d3.curveBasis;
      });

      let svg = d3.select("svg");
      let inner = svg.append("g");

      // configure zooming
      var zoom = d3.zoom().on("zoom", () => {
        inner.attr("transform", d3.event.transform);
      });
      // uncomment this if you want zooming to be enabled
      // svg.call(zoom);

      // render graph
      let render = new dagreD3.render();

      render.shapes()["for"] = function(parent, bbox, node) {
        var w = bbox.width,
            h = bbox.height,
            points = [
              { x:   0, y:        0 },
              { x:   w, y:        0 },
              { x:   w, y:       -h },
              { x: w/2, y: -h * 3/2 },
              { x:   0, y:       -h }
            ];
            shapeSvg = parent.insert("polygon", ":first-child")
              .attr("points", points.map(function(d) { return d.x + "," + d.y; }).join(" "))
              .attr("transform", "translate(" + (-w/2) + "," + (h * 3/4) + ")");

        node.intersect = function(point) {
          return dagreD3.intersect.polygon(node, points, point);
        };

        return shapeSvg;
      };

      render(inner, g);

      // set svg viewBox but add 2 pixels so that borders are drawn correctly
      let l = Math.floor(Math.min(0, svg.node().getBBox().x));
      let t = Math.floor(Math.min(0, svg.node().getBBox().y));
      let w = Math.ceil(Math.max(g.graph().width, svg.node().getBBox().width)) + 2;
      let h = Math.ceil(Math.max(g.graph().height, svg.node().getBBox().height)) + 2;
      svg.call(zoom.transform, d3.zoomIdentity.translate(1, 1));
      svg.attr("viewBox", l + " " + t + " " + w + " " + h);
      svg.style("max-width", w + "px");

      // move cluster labels to top-left
      svg.selectAll(".cluster").each(function () {
        let cluster = d3.select(this);
        let r = cluster.node().getBoundingClientRect();
        cluster.select(".label").select("g").attr("transform",
            "translate(" + (-r.width / 2 + 7) + "," + (-r.height / 2 + 5) + ")");
      });

      // The #workflow-graph is initially out of view (position: absolute; left: 10000px).
      // After rendering, move #workflow-graph inside the accordion
      d3.select("#workflow-graph-container").select(function() {
        return this.appendChild(document.getElementById("workflow-graph"))
      });
      d3.select("#workflow-graph").style("position", "relative").style("left", 0);

      // limit graph to a reasonable size
      const MAX_WIDTH = 5000;
      const MAX_HEIGHT = 20000;
      if (w > MAX_WIDTH || h > MAX_HEIGHT) {
        invalidGraph = true;
      }

      if (invalidGraph) {
        d3.select("#workflow-graph").html('<div class="ui ignored warning message">' +
          'Workflow graph is too large to be displayed.</div>');
      }
    }
  }
});

$(".message .close").on("click", () => {
  app.workflowsAdded = false;
});

let eb = new EventBus(basePath + "/eventbus");
eb.enableReconnect(true);
eb.onopen = () => {
  if (!window.singleWorkflow) {
    eb.registerHandler("steep.submissionRegistry.submissionAdded", (error, message) => {
      if (page.offset > 0) {
        app.workflowsAdded = true;
      } else {
        let w = message.body;
        initWorkflow(w);
        app.workflows.unshift(w);
        if (app.workflows.length > app.page.size) {
          app.workflows.pop();
        }
        app.page.total++;
      }
    });
  }

  eb.registerHandler("steep.submissionRegistry.submissionStartTimeChanged", (error, message) => {
    let w = app.findWorkflowById(message.body.submissionId);
    if (w) {
      w.startTime = message.body.startTime;
    }
  });

  eb.registerHandler("steep.submissionRegistry.submissionEndTimeChanged", (error, message) => {
    let w = app.findWorkflowById(message.body.submissionId);
    if (w) {
      w.endTime = message.body.endTime;
    }
  });

  eb.registerHandler("steep.submissionRegistry.submissionStatusChanged", (error, message) => {
    let w = app.findWorkflowById(message.body.submissionId);
    if (w) {
      w.status = message.body.status;
    }
  });

  if (window.singleWorkflow) {
    eb.registerHandler("steep.submissionRegistry.submissionErrorMessageChanged", (error, message) => {
      let w = app.findWorkflowById(message.body.submissionId);
      if (w) {
        w.errorMessage = message.body.errorMessage;
      }
    });
  }

  eb.registerHandler("steep.submissionRegistry.processChainsAddedSize", (error, message) => {
    let pcsSize = message.body.processChainsSize;
    let submissionId = message.body.submissionId;
    let status = message.body.status;
    let w = app.findWorkflowById(submissionId);
    if (!w) {
      return;
    }

    w.totalProcessChains += pcsSize;
    if (status === "RUNNING") {
      w.runningProcessChains += pcsSize;
    } else if (status === "CANCELLED") {
      w.cancelledProcessChains += pcsSize;
    } else if (status === "ERROR") {
      w.failedProcessChains += pcsSize;
    } else if (status === "SUCCESS") {
      w.succeededProcessChains += pcsSize;
    }
  });

  eb.registerHandler("steep.submissionRegistry.processChainStatusChanged", (error, message) => {
    let submissionId = message.body.submissionId;
    let status = message.body.status;
    let previousStatus = message.body.previousStatus;
    let w = app.findWorkflowById(submissionId);
    if (!w) {
      return;
    }

    if (previousStatus !== status) {
      if (previousStatus === "RUNNING") {
        w.runningProcessChains = Math.max(w.runningProcessChains - 1, 0);
      } else if (previousStatus === "CANCELLED") {
        w.cancelledProcessChains = Math.max(w.cancelledProcessChains - 1, 0);
      } else if (previousStatus === "ERROR") {
        w.failedProcessChains = Math.max(w.failedProcessChains - 1, 0);
      } else if (previousStatus === "SUCCESS") {
        w.succeededProcessChains = Math.max(w.succeededProcessChains - 1, 0);
      }

      if (status === "RUNNING") {
        w.runningProcessChains++;
      } else if (status === "CANCELLED") {
        w.cancelledProcessChains++;
      } else if (status === "ERROR") {
        w.failedProcessChains++;
      } else if (status === "SUCCESS") {
        w.succeededProcessChains++;
      }
    }
  });

  eb.registerHandler("steep.submissionRegistry.processChainAllStatusChanged", (error, message) => {
    let submissionId = message.body.submissionId;
    let currentStatus = message.body.currentStatus;
    let newStatus = message.body.newStatus;
    let w = app.findWorkflowById(submissionId);
    if (!w) {
      return;
    }

    if (currentStatus !== newStatus) {
      let n = 0;
      if (currentStatus === "REGISTERED") {
        n = w.totalProcessChains - w.runningProcessChains -
            w.failedProcessChains - w.succeededProcessChains -
            w.cancelledProcessChains;
      } else if (currentStatus === "RUNNING") {
        n = w.runningProcessChains;
        w.runningProcessChains = 0;
      } else if (currentStatus === "CANCELLED") {
        n = w.cancelledProcessChains;
        w.cancelledProcessChains = 0;
      } else if (currentStatus === "ERROR") {
        n = w.failedProcessChains;
        w.failedProcessChains = 0;
      } else if (currentStatus === "SUCCESS") {
        n = w.succeededProcessChains;
        w.succeededProcessChains = 0;
      }

      if (newStatus === "RUNNING") {
        w.runningProcessChains += n;
      } else if (newStatus === "CANCELLED") {
        w.cancelledProcessChains += n;
      } else if (newStatus === "ERROR") {
        w.failedProcessChains += n;
      } else if (newStatus === "SUCCESS") {
        w.succeededProcessChains += n;
      }
    }
  });
};
