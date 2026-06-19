# TensorFlow Basics

> **Why a quant must own this:** Deep learning shows up in quant for sequence
> models on order flow, autoencoders for anomaly/regime detection, and large
> tabular nets. TensorFlow (with Keras) is one of the two dominant frameworks.
> The concepts that matter — tensors, automatic differentiation via
> `GradientTape`, graph compilation with `@tf.function`, and GPU device placement
> — are the same ideas you'll meet in PyTorch, so this lesson is as much about
> the *mental model of differentiable array computing* as about one API.

## First principles: tensors and autodiff

A **tensor** is an n-dimensional array (like a NumPy `ndarray`) that additionally
lives on a chosen **device** (CPU/GPU/TPU) and can be tracked for
differentiation. The two ideas that distinguish a DL framework from NumPy:

1. **Automatic differentiation** — the framework records the operations you
   perform and can compute exact gradients of any output w.r.t. any input by
   reverse-mode autodiff (backpropagation).
2. **Device acceleration & graph compilation** — operations run on GPU/TPU and
   can be fused into a compiled graph for speed.

```python
import tensorflow as tf

x = tf.constant([[1.0, 2.0], [3.0, 4.0]])   # a rank-2 tensor (a matrix)
print(x.shape, x.dtype, x.device)            # (2,2) float32 ...:CPU/GPU

# tensors behave like NumPy and interconvert (zero-copy on CPU)
import numpy as np
np_view = x.numpy()                          # tensor -> ndarray
back = tf.convert_to_tensor(np_view)         # ndarray -> tensor
```

> Default dtype is **`float32`** (DL convention: half the memory/bandwidth of
> `float64`, GPU-friendly, ample precision for gradient descent). This contrasts
> with NumPy's `float64` default — a frequent source of subtle dtype mismatches.

## `GradientTape`: autodiff in action

`tf.GradientTape` records operations on watched tensors so you can differentiate.
This is the engine under every optimizer.

```python
w = tf.Variable(0.0)                          # a trainable parameter
b = tf.Variable(0.0)
xs = tf.constant([1., 2., 3., 4.])
ys = tf.constant([2., 4., 6., 8.])            # target: y = 2x

with tf.GradientTape() as tape:               # records the forward computation
    pred = w * xs + b
    loss = tf.reduce_mean((pred - ys) ** 2)   # MSE
dw, db = tape.gradient(loss, [w, b])          # exact dLoss/dw, dLoss/db
print(dw.numpy(), db.numpy())                 # gradients computed by backprop
```

A full training step applies these gradients via an optimizer:

```python
opt = tf.keras.optimizers.SGD(learning_rate=0.01)
for _ in range(200):
    with tf.GradientTape() as tape:
        loss = tf.reduce_mean((w * xs + b - ys) ** 2)
    grads = tape.gradient(loss, [w, b])
    opt.apply_gradients(zip(grads, [w, b]))   # w,b nudged down the gradient
print(w.numpy(), b.numpy())                    # -> ~2.0, ~0.0
```

## Keras: the high-level API you'll usually use

For real models you rarely write the loop by hand — Keras provides layers,
losses, and a `fit` loop with batching, validation, and callbacks.

```python
model = tf.keras.Sequential([
    tf.keras.layers.Input(shape=(n_features,)),
    tf.keras.layers.Dense(64, activation="relu"),
    tf.keras.layers.Dropout(0.2),
    tf.keras.layers.Dense(1),                  # regression head (predict a return)
])
model.compile(optimizer="adam", loss="mse")
model.fit(X_train, y_train, validation_data=(X_val, y_val),
          epochs=50, batch_size=256,
          callbacks=[tf.keras.callbacks.EarlyStopping(patience=5)])
preds = model.predict(X_test)
```

## `@tf.function`: eager vs graph

By default TF runs **eagerly** (op-by-op, like NumPy — easy to debug). Wrapping a
function in `@tf.function` traces it into a **compiled graph** that fuses ops,
removes Python overhead, and runs much faster — the same eager-vs-compiled
trade-off as the rest of this track's performance story.

```python
@tf.function                                   # trace to a graph on first call
def train_step(x, y):
    with tf.GradientTape() as tape:
        loss = tf.reduce_mean((model(x) - y) ** 2)
    grads = tape.gradient(loss, model.trainable_variables)
    opt.apply_gradients(zip(grads, model.trainable_variables))
    return loss
```

`@tf.function` **re-traces** when it sees new input shapes/dtypes (slow if your
shapes vary every call), and Python side effects (prints, list appends) inside it
behave surprisingly because they run only during tracing — a classic gotcha.

## Diagram: the training loop

```text
   X ──▶ model(forward) ──▶ predictions ──▶ loss
                                              │  (GradientTape recorded the path)
        parameters  ◀── optimizer.apply ◀── gradients = tape.gradient(loss, params)
        repeat per batch / epoch
```

## Data pipelines: `tf.data`

Feeding data efficiently (so the GPU isn't starved) uses `tf.data.Dataset` with
batching, shuffling, and prefetching:

```python
ds = (tf.data.Dataset.from_tensor_slices((X_train, y_train))
        .shuffle(10_000)            # NOTE: shuffling is fine for i.i.d. tabular,
        .batch(256)                 #       NOT for sequential financial windows
        .prefetch(tf.data.AUTOTUNE))
model.fit(ds, epochs=50)
```

## Performance reality

- **GPU acceleration** is the point: matrix multiplies and convolutions run on
  thousands of cores. But moving data CPU↔GPU is expensive — keep tensors on the
  device and feed via `tf.data` with `prefetch` so transfer overlaps compute.
- **`float32`** (or mixed `float16`/`bfloat16` precision) is standard; `float64`
  doubles memory and is much slower on GPU and usually unnecessary for SGD.
- **`@tf.function`** gives large speedups by removing Python/eager overhead and
  fusing kernels — but watch retracing on variable shapes.
- **Batch size** trades throughput (bigger = better GPU utilization) against
  memory and generalization. Too small starves the GPU.
- DL is overkill for small tabular quant problems — a regularized linear model or
  gradient-boosted trees (previous lesson) usually beats a neural net when data
  is limited and signal is weak. Use TF when you have sequence structure and lots
  of data.

## Quant relevance & interview gotchas

- **Don't shuffle time-ordered data** into train/test as if i.i.d. — the
  sequential-CV / lookahead lesson applies here too. Split by time; for sequence
  models, window without overlapping train/test.
- **Tiny signal, huge model = overfitting:** financial data has a low
  signal-to-noise ratio; a high-capacity net memorizes noise. Regularize
  (dropout, weight decay, early stopping) and validate out-of-sample.
- **dtype mismatch** (`float64` NumPy features into a `float32` model) triggers
  casts or errors — standardize to `float32`.
- **Non-stationarity:** a model trained on one regime degrades; retrain/roll and
  monitor.
- **Reproducibility:** set seeds (`tf.random.set_seed`), but GPU nondeterminism
  (atomic adds) can still cause small run-to-run differences — know this when a
  result "won't replicate exactly."
- **Eager vs graph confusion:** Python prints/side-effects inside `@tf.function`
  run only at trace time — a real debugging trap.

## Key takeaways

1. A tensor is a device-resident, differentiable n-D array; default dtype is
   `float32` (vs NumPy's `float64`).
2. `tf.GradientTape` records the forward pass and computes exact gradients by
   reverse-mode autodiff — the core of training.
3. The loop is forward → loss → `tape.gradient` → `optimizer.apply_gradients`;
   Keras `fit` automates it.
4. `@tf.function` compiles eager code into a fused graph for speed but re-traces
   on new shapes and mishandles Python side effects.
5. Keep data on the GPU and feed via `tf.data` (batch/prefetch); use `float32`/
   mixed precision.
6. For weak-signal tabular quant problems, simpler models often beat DL; never
   shuffle time-ordered data and always validate out-of-sample.

## Self-check

1. What two capabilities distinguish a TensorFlow tensor from a NumPy array?
2. Write the four steps of one gradient-descent training step using
   `GradientTape`.
3. Why is the default dtype `float32`, and what breaks if you feed `float64`
   NumPy features?
4. What does `@tf.function` do, and name two gotchas (retracing, side effects).
5. Why is shuffling a financial time series into train/val sets dangerous, even
   with a neural net?
6. Why might a high-capacity net underperform a linear model on a return-
   prediction task?

## Further reading

- [TensorFlow Core: tensors & automatic differentiation](https://www.tensorflow.org/guide/autodiff) and [intro to gradients](https://www.tensorflow.org/guide/basics).
- [`tf.function` / Better performance with tf.function](https://www.tensorflow.org/guide/function).
- [Keras guides](https://www.tensorflow.org/guide/keras) and [`tf.data` input pipelines](https://www.tensorflow.org/guide/data).
- [Mixed precision training](https://www.tensorflow.org/guide/mixed_precision).
- Aurélien Géron, *Hands-On Machine Learning with Scikit-Learn, Keras & TensorFlow*, 3rd ed.

## Videos

- TensorFlow — **"Intro to TensorFlow"** / **"Inside TensorFlow"** official talks ([search](https://www.youtube.com/results?search_query=Intro+to+TensorFlow+Inside+TensorFlow+official)).
- PyData — **"Deep learning for time series / finance"** talks ([search](https://www.youtube.com/results?search_query=PyData+deep+learning+time+series+finance)).
