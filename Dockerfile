
# Taking ARM64 EKS-supported OS as a base image
FROM arm64v8/ubuntu:22.04

ARG EFA_INSTALLER_VERSION=latest
ARG AWS_OFI_NCCL_VERSION=aws
ARG NCCL_TESTS_VERSION=v2.0.0

RUN apt-get update -y
RUN apt-get dist-upgrade -y
RUN apt-get purge -y libmlx5-1 ibverbs-utils libibverbs-dev libibverbs1
# Set timezone
RUN ln -snf /usr/share/zoneinfo/$CONTAINER_TIMEZONE /etc/localtime && echo $CONTAINER_TIMEZONE > /etc/timezone
# Need them for EFA drivers installation
ENV DEBIAN_FRONTEND=noninteractive 
ENV OMPI_ALLOW_RUN_AS_ROOT=1
ENV OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1
RUN apt-get install -f -y --allow-unauthenticated --force-yes \
    sudo \
    apt-utils \
    libevent-core-2.1-7 \
    libevent-pthreads-2.1-7 \
    libhwloc15 \
    udev \
    git \
    gcc \
    net-tools \
    vim \
    kmod \
    openssh-client \
    openssh-server \
    build-essential \
    curl \
    autoconf \
    libtool \
    gdb \
    automake \
    python3-distutils \
    cmake \
    m4 \
    pciutils \
    environment-modules \
    tcl \
    libnl-3-200 libnl-3-dev libnl-route-3-200 libnl-route-3-dev \
    gnuplot \
    && rm -rf /var/lib/apt/lists/*

ENV HOME /tmp

ENV LD_LIBRARY_PATH=/usr/local/cuda/extras/CUPTI/lib64:/opt/amazon/openmpi/lib:/opt/nccl/build/lib:/opt/amazon/efa/lib:/opt/aws-ofi-nccl/install/lib:$LD_LIBRARY_PATH
ENV PATH=/opt/amazon/openmpi/bin/:/opt/amazon/efa/bin:$PATH

RUN curl https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py && python3 /tmp/get-pip.py
RUN pip3 install awscli

RUN cd $HOME \
    && curl -O https://efa-installer.amazonaws.com/aws-efa-installer-${EFA_INSTALLER_VERSION}.tar.gz \
    && tar -xf $HOME/aws-efa-installer-${EFA_INSTALLER_VERSION}.tar.gz \
    && cd aws-efa-installer \
    && sudo ./efa_installer.sh -y -g -d --skip-kmod --skip-limit-conf --no-verify

